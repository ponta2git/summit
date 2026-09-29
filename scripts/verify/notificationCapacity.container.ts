import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { z } from "zod";
import { AssertionError } from "node:assert";
import { CapacityError, type CapacityScenario } from "./notificationCapacity.contract.ts";
import { notificationCapacityProbe } from "./notificationCapacity.probe.ts";
import type { CapacitySession } from "./notificationCapacity.scenarios.ts";

const execute = promisify(execFile);
const docker = async (args: readonly string[]): Promise<string> =>
  (await execute("docker", [...args], { timeout: 10_000, maxBuffer: 64 * 1024 })).stdout.trim();

export const withCapacityContainer = async <T>(options: {
  readonly image: string;
  readonly memoryMiB: number;
  readonly databaseUrl: string;
  readonly configuration: string;
  readonly scenario: CapacityScenario;
}, run: (session: CapacitySession) => Promise<T>): Promise<T> => {
  const name = `summit-capacity-check-${randomUUID()}`;
  const token = randomUUID() + randomUUID();
  const deadline = new AbortController();
  const timeout = setTimeout(() => deadline.abort(), options.scenario === "standard" ? 180_000 : 90_000);
  let started = false;
  let heapOutOfMemory = false;
  try {
    await docker(["image", "inspect", "--format", "{{.Id}}", options.image]);
    const url = new URL(options.databaseUrl);
    url.hostname = "host.docker.internal";
    const child = spawn("docker", ["run", "--pull=never", "--name", name, "--read-only", "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges", "--memory", `${options.memoryMiB}m`, "--memory-swap", `${options.memoryMiB}m`,
      ...(process.platform === "linux" ? ["--add-host", "host.docker.internal=host-gateway"] : []),
      "--publish", "127.0.0.1::8000", "--publish", "127.0.0.1::8001", "--env", "TZ=Asia/Tokyo",
      "--env", "DISCORD_TOKEN=offline-capacity-token", "--env", "DATABASE_URL", "--env", "SUMMIT_CONFIG_YAML",
      "--env", "PROBE_TOKEN", "--env", "RESULT_NOTIFICATION_TOKEN", "--env", "RESULT_NOTIFICATION_OPERATIONS_TOKEN",
      "--env", "RESULT_NOTIFICATION_WEB_ORIGIN=https://results.example.com",
      "--entrypoint", "node", "-i", options.image, "--expose-gc", "--input-type=module", "-"], {
      stdio: ["pipe", "pipe", "pipe"], signal: deadline.signal, env: { ...process.env,
        DATABASE_URL: url.href, SUMMIT_CONFIG_YAML: options.configuration, PROBE_TOKEN: token,
        RESULT_NOTIFICATION_TOKEN: token, RESULT_NOTIFICATION_OPERATIONS_TOKEN: randomUUID() + randomUUID() }
    });
    started = true;
    // Never print child errors: driver errors can include configuration/payloads.
    let tail = "";
    child.stderr.on("data", (chunk: Buffer) => {
      tail = (tail + chunk.toString()).slice(-2_048);
      heapOutOfMemory ||= /heap out of memory/i.test(tail);
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject); child.once("exit", resolve);
    });
    void exited.catch(() => undefined);
    child.stdin.on("error", () => undefined);
    child.stdin.end(notificationCapacityProbe);
    const ready = async (): Promise<void> => {
      const lines = createInterface({ input: child.stdout });
      try { for await (const line of lines) { if (line === "CAPACITY_READY") { return; } } }
      finally { lines.close(); }
      throw new CapacityError("setup_or_measurement");
    };
    await Promise.race([ready(), exited.then(() => { throw new CapacityError("setup_or_measurement"); })]);
    const origin = async (port: number): Promise<string> => {
      const address = await docker(["port", name, `${port}/tcp`]);
      if (!/^127\.0\.0\.1:[0-9]+$/.test(address)) { throw new CapacityError("setup_or_measurement"); }
      return `http://${address}`;
    };
    const receiverOrigin = await origin(8000);
    const controlOrigin = await origin(8001);
    const value = await run({ receiverOrigin, controlOrigin, token, signal: deadline.signal });
    if (await exited !== 0) { throw new CapacityError("setup_or_measurement"); }
    return value;
  } catch (error) {
    const state = started ? await docker(["inspect", "--format", "{{json .State}}", name]).catch(() => "null") : "null";
    let oom = heapOutOfMemory;
    try {
      const parsed = z.object({ OOMKilled: z.boolean() }).safeParse(JSON.parse(state));
      oom ||= parsed.success && parsed.data.OOMKilled;
    } catch { /* Malformed Docker output is a measurement failure. */ }
    const detail = error instanceof CapacityError ? error.detail : error instanceof AssertionError
      ? `assert_${error.operator}_${typeof error.actual === "number" ? error.actual : "value"}_${typeof error.expected === "number" ? error.expected : "value"}`
      : undefined;
    throw new CapacityError(oom ? "oom" : deadline.signal.aborted ? "timeout"
      : error instanceof CapacityError ? error.code : "setup_or_measurement", detail);
  } finally {
    clearTimeout(timeout);
    if (started) { await docker(["rm", "--force", name]); }
  }
};
