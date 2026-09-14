import { spawn } from "node:child_process";
import type * as ChildProcessModule from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { superviseCommandSync } from "../../../src/commands/sync.supervisor.ts";
import { SYNC_DEADLINE_MS, SYNC_EXIT_GRACE_MS } from "../../../src/commands/sync.protocol.ts";

vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof ChildProcessModule>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
const directories: string[] = [];
const fixture = (code: string): URL => {
  const directory = mkdtempSync(join(tmpdir(), "summit-sync-test-")); directories.push(directory);
  const path = join(directory, "worker.mjs"); writeFileSync(path, code); return pathToFileURL(path);
};
const actualWorker = (code: string): URL => fixture(`
  import { REST } from ${JSON.stringify(import.meta.resolve("@discordjs/rest"))};
  import { slashCommands } from ${JSON.stringify(new URL("../../../src/commands/definitions.ts", import.meta.url).href)};
  ${code}
  await import(${JSON.stringify(new URL("../../../src/commands/sync.worker.ts", import.meta.url).href)});
`);
const environment = { DISCORD_TOKEN: "controlled-dummy-token", DISCORD_APPLICATION_ID: "100000000000000001", DISCORD_GUILD_ID: "100000000000000002" };
const child = () => {
  const value = vi.mocked(spawn).mock.results.at(-1)?.value;
  if (!value) { throw new Error("Worker did not spawn"); }
  return value;
};
afterEach(() => {
  for (const result of vi.mocked(spawn).mock.results) {
    const process = result.value;
    if (process && process.exitCode === null && process.signalCode === null) { process.kill("SIGKILL"); }
  }
  vi.useRealTimers();
  for (const directory of directories.splice(0)) { rmSync(directory, { recursive: true, force: true }); }
});

describe("command sync process ownership", () => {
  it("rejects Fly and invalid switches before spawning any child", async () => {
    expect(await superviseCommandSync([], { FLY_APP_NAME: "test" })).toStrictEqual({ status: "failed", reason: "fly_environment" });
    expect(await superviseCommandSync(["--token=PRIVATE"], {})).toStrictEqual({ status: "failed", reason: "usage" });
    expect(spawn).not.toHaveBeenCalled();
  });
  it("projects IPC output, passes only required credentials and excludes shell/Node options", async () => {
    const worker = fixture(`
      const safe = process.env.DISCORD_TOKEN === 'PRIVATE' && !process.env.DATABASE_URL && !process.env.SUMMIT_CONFIG_YAML && !process.env.NODE_OPTIONS && !process.argv.includes('PRIVATE');
      process.stdout.write('PRIVATE'); process.stderr.write('PRIVATE');
      process.send({ status: safe ? 'matched' : 'failed', token: 'PRIVATE' }, () => process.exit(safe ? 0 : 1));
    `);
    expect(await superviseCommandSync(["--production"], { DISCORD_TOKEN: "PRIVATE", DATABASE_URL: "PRIVATE", SUMMIT_CONFIG_YAML: "PRIVATE", NODE_OPTIONS: "--invalid" }, { worker }))
      .toStrictEqual({ status: "matched" });
    expect(child().exitCode).toBe(0);
  });
  it("requires a report and matching exit status before reporting success", async () => {
    expect(await superviseCommandSync(["--check"], {}, { worker: fixture("process.exit(0);") }))
      .toStrictEqual({ status: "failed", reason: "worker_failed" });
    expect(await superviseCommandSync([], {}, { worker: fixture("process.send({status:'synced'}, () => process.exit(1));") }))
      .toStrictEqual({ status: "unknown", reason: "worker_failed" });
  });
  it("does not turn a contradictory IPC report into a successful apply", async () => {
    expect(await superviseCommandSync([], {}, { worker: fixture("process.send({status:'synced',reason:'request_failed'}, () => process.exit(0));") }))
      .toStrictEqual({ status: "unknown", reason: "worker_failed" });
  });
  it("rejects missing production settings through the actual worker without reading local files", async () => {
    expect(await superviseCommandSync(["--production", "--check"], { DATABASE_URL: "PRIVATE", SUMMIT_CONFIG_YAML: "PRIVATE" }))
      .toStrictEqual({ status: "failed", reason: "invalid_settings" });
  });
  it("finishes the actual worker even when an SDK-style timer remains", async () => {
    const worker = actualWorker(`
      REST.prototype.get = async () => slashCommands;
      REST.prototype.put = async () => { throw new Error('Unexpected write'); };
      setInterval(() => {}, 1000);
    `);
    expect(await superviseCommandSync(["--production"], environment, { worker })).toStrictEqual({ status: "matched" });
    expect(child().exitCode).toBe(0);
  });
  it("confirms a write through the actual worker and IPC boundary", async () => {
    const worker = actualWorker(`
      let written = false;
      REST.prototype.get = async () => written ? slashCommands : [];
      REST.prototype.put = async (_route, { body }) => {
        if (JSON.stringify(body) !== JSON.stringify(slashCommands) || written) throw new Error('Invalid write');
        written = true; return slashCommands;
      };
    `);
    expect(await superviseCommandSync(["--production"], environment, { worker })).toStrictEqual({ status: "synced" });
  });
  it("forwards cancellation to the actual request and kills it if abort does not settle I/O", async () => {
    vi.useFakeTimers(); const controller = new AbortController();
    const worker = actualWorker(`
      REST.prototype.get = (_route, { signal }) => new Promise(() => {
        signal.addEventListener('abort', () => process.send({aborted:true}), {once:true});
        setInterval(() => {}, 1000); process.send({ready:true});
      });
      REST.prototype.put = async () => { throw new Error('Unexpected write'); };
    `);
    const pending = superviseCommandSync(["--production"], environment, { worker, signal: controller.signal });
    const running = child(); await once(running, "message");
    const aborted = once(running, "message"); controller.abort();
    expect(await aborted).toStrictEqual([{ aborted: true }, undefined]);
    await vi.advanceTimersByTimeAsync(SYNC_EXIT_GRACE_MS);
    expect(await pending).toStrictEqual({ status: "unknown", reason: "cancelled" });
    expect(running.signalCode).toBe("SIGKILL"); expect(vi.getTimerCount()).toBe(0);
  });
  it("exits the actual worker if its parent IPC connection disappears", async () => {
    const worker = actualWorker(`
      REST.prototype.get = () => new Promise(() => { setInterval(() => {}, 1000); process.send({ready:true}); });
      REST.prototype.put = async () => { throw new Error('Unexpected write'); };
    `);
    const pending = superviseCommandSync(["--production", "--check"], environment, { worker });
    const running = child(); await once(running, "message"); running.disconnect();
    expect(await pending).toStrictEqual({ status: "failed", reason: "worker_failed" });
    expect(running.exitCode).toBe(1);
  });
  it("kills a TERM-resistant child after the total deadline and grace period, then reaps it", async () => {
    vi.useFakeTimers();
    const worker = fixture("process.on('SIGTERM', () => process.send({term:true})); setInterval(() => {}, 1000); process.send({ready:true});");
    const pending = superviseCommandSync([], {}, { worker }); const running = child();
    await once(running, "message");
    const terminated = once(running, "message");
    await vi.advanceTimersByTimeAsync(SYNC_DEADLINE_MS);
    await terminated;
    expect(running.signalCode).toBeNull();
    await vi.advanceTimersByTimeAsync(SYNC_EXIT_GRACE_MS);
    expect(await pending).toStrictEqual({ status: "unknown", reason: "deadline_exceeded" });
    expect(running.signalCode).toBe("SIGKILL");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels a read-only command and clears all parent timers", async () => {
    vi.useFakeTimers(); const controller = new AbortController();
    const worker = fixture("process.on('SIGTERM', () => process.exit(1)); setInterval(() => {}, 1000); process.send({ready:true});");
    const pending = superviseCommandSync(["--check"], {}, { worker, signal: controller.signal });
    await once(child(), "message"); controller.abort();
    expect(await pending).toStrictEqual({ status: "failed", reason: "cancelled" });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not start a worker for a previously cancelled request", async () => {
    const controller = new AbortController(); controller.abort();
    expect(await superviseCommandSync([], {}, { signal: controller.signal })).toStrictEqual({ status: "failed", reason: "cancelled" });
    expect(spawn).not.toHaveBeenCalled();
  });
});
