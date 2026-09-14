import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const entry = fileURLToPath(new URL("../../../src/commands/sync.ts", import.meta.url));

describe("command sync CLI", () => {
  it.each([
    { args: ["--production", "--check"], env: { DISCORD_TOKEN: "PRIVATE" }, reason: "invalid_settings" },
    { args: ["--production"], env: { FLY_APP_NAME: "test", DISCORD_TOKEN: "PRIVATE" }, reason: "fly_environment" },
    { args: ["--token=PRIVATE"], env: {}, reason: "usage" }
  ])("returns a classified failure without exposing settings: $reason", ({ args, env, reason }) => {
    const result = spawnSync(process.execPath, [entry, ...args], { env, encoding: "utf8", timeout: 10_000 });
    expect(result.error).toBeUndefined(); expect(result.status).toBe(1); expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("PRIVATE");
    expect(JSON.parse(result.stdout)).toMatchObject({ event: "commands.sync", status: "failed", reason });
  });
  it("refuses direct worker invocation without a parent before any SDK initialization", () => {
    const worker = fileURLToPath(new URL("../../../src/commands/sync.worker.ts", import.meta.url));
    const result = spawnSync(process.execPath, [worker, "--production"], { env: {}, encoding: "utf8", timeout: 10_000 });
    expect(result.error).toBeUndefined(); expect(result.status).toBe(1);
    expect(result.stdout).toBe(""); expect(result.stderr).toBe("");
  });
});
