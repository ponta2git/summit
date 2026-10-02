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
  readonly probeScript?: string;
  readonly readyMarker?: string;
  readonly cpus?: number;
  readonly deadlineMs?: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}, run: (session: CapacitySession) => Promise<T>): Promise<T> => {
  if ((options.cpus !== undefined && (!Number.isFinite(options.cpus) || options.cpus <= 0 || options.cpus > 64))
    || (options.deadlineMs !== undefined && (!Number.isSafeInteger(options.deadlineMs) || options.deadlineMs < 1 || options.deadlineMs > 3_600_000))
    || Object.entries(options.env ?? {}).some(([key, value]) => !/^PERF_[A-Z0-9_]+$/.test(key) || value.includes("\0") || value.length > 128)) {
    throw new CapacityError("setup_or_measurement", "container_options");
  }
  const name = `summit-capacity-check-${randomUUID()}`;
  const token = randomUUID() + randomUUID();
  const deadline = new AbortController();
  const interrupt = (): void => deadline.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", interrupt, { once: true });
  if (options.signal?.aborted) { interrupt(); }
  const timeout = setTimeout(() => deadline.abort(), options.deadlineMs ?? (options.scenario === "standard" ? 180_000 : 90_000));
  let started = false;
  let heapOutOfMemory = false;
  try {
    deadline.signal.throwIfAborted();
    await docker(["image", "inspect", "--format", "{{.Id}}", options.image]);
    deadline.signal.throwIfAborted();
    const url = new URL(options.databaseUrl);
    url.hostname = "host.docker.internal";
    const child = spawn("docker", ["run", "--pull=never", "--name", name, "--read-only", "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges", "--memory", `${options.memoryMiB}m`, "--memory-swap", `${options.memoryMiB}m`,
      ...(options.cpus === undefined ? [] : ["--cpus", String(options.cpus)]),
      ...(process.platform === "linux" ? ["--add-host", "host.docker.internal=host-gateway"] : []),
      "--publish", "127.0.0.1::8000", "--publish", "127.0.0.1::8001", "--env", "TZ=Asia/Tokyo",
      "--env", "DISCORD_TOKEN=offline-capacity-token", "--env", "DATABASE_URL", "--env", "SUMMIT_CONFIG_YAML",
      "--env", "PROBE_TOKEN", "--env", "RESULT_NOTIFICATION_TOKEN", "--env", "RESULT_NOTIFICATION_OPERATIONS_TOKEN",
      "--env", "RESULT_NOTIFICATION_WEB_ORIGIN=https://results.example.com",
      ...Object.keys(options.env ?? {}).flatMap(key => ["--env", key]),
      "--entrypoint", "node", "-i", options.image, "--expose-gc", "--input-type=module", "-"], {
      stdio: ["pipe", "pipe", "pipe"], signal: deadline.signal, env: { ...process.env,
        DATABASE_URL: url.href, SUMMIT_CONFIG_YAML: options.configuration, PROBE_TOKEN: token,
        RESULT_NOTIFICATION_TOKEN: token, RESULT_NOTIFICATION_OPERATIONS_TOKEN: randomUUID() + randomUUID(), ...options.env }
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
    child.stdin.end(options.probeScript ?? notificationCapacityProbe);
    const ready = async (): Promise<void> => {
      const lines = createInterface({ input: child.stdout });
      try { for await (const line of lines) { if (line === (options.readyMarker ?? "CAPACITY_READY")) { return; } } }
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
    deadline.signal.throwIfAborted();
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
    if (!oom && options.signal?.aborted) {
      throw options.signal.reason instanceof CapacityError ? options.signal.reason : new CapacityError("setup_or_measurement", "interrupted");
    }
    if (!oom && !deadline.signal.aborted && error instanceof CapacityError) { throw error; }
    const detail = error instanceof CapacityError ? error.detail : error instanceof AssertionError
      ? `assert_${error.operator}_${typeof error.actual === "number" ? error.actual : "value"}_${typeof error.expected === "number" ? error.expected : "value"}`
      : undefined;
    throw new CapacityError(oom ? "oom" : deadline.signal.aborted ? "timeout"
      : error instanceof CapacityError ? error.code : "setup_or_measurement", detail);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", interrupt);
    if (started) { await docker(["rm", "--force", name]); }
  }
};
