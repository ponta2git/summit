import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { z } from "zod";
import { RESULT_NOTIFICATION_CONCURRENCY, RESULT_NOTIFICATION_MAX_BODY_BYTES, RESULT_NOTIFICATION_MAX_JSONB_BYTES } from "../../src/notifications/config.ts";
import { analysisNotification } from "../../tests/features/result-notifications/fixtures.ts";
import { databaseUrl, dropOwnedDatabase, newDatabasePrefix, requireLocalTestUrl } from "../../tests/integration/databaseLifecycle.ts";
import { notificationCapacityProbe } from "./notificationCapacity.probe.ts";

const root = new URL("../../", import.meta.url);
const execute = promisify(execFile);
const docker = async (args: readonly string[]): Promise<string> =>
  (await execute("docker", [...args], { timeout: 10_000, maxBuffer: 64 * 1024 })).stdout.trim();
const connect = (url: string) => postgres(url, { max: 1, prepare: false, connect_timeout: 5,
  onnotice: () => undefined, connection: { statement_timeout: 30_000, lock_timeout: 5_000 } });
const metricsSchema = z.object({
  baselineRss: z.number().positive(), peakRss: z.number().positive(), maxRss: z.number().positive(),
  cgroupPeak: z.number().positive(), received: z.literal(1),
  retained: z.literal(RESULT_NOTIFICATION_CONCURRENCY), renderedParts: z.number().int().positive()
});

const payload = (sourceJobId: string, retained: boolean) => {
  const base = analysisNotification();
  const first = base.data.matches[0];
  if (!first) { throw new Error("Missing capacity fixture"); }
  const text = "界" + (retained ? "*" : "x").repeat(RESULT_NOTIFICATION_MAX_JSONB_BYTES - 8_192);
  return { ...base, sourceJobId, notificationId: `result:analysis_completed:${sourceJobId}`, data: {
    ...base.data, ...(retained ? { matches: [], gameTitleName: text } : { matches: [{ ...first, note: text }] })
  } };
};

const prepareDatabase = async (url: string, signal: AbortSignal): Promise<void> => {
  const client = connect(url);
  const abort = (): void => { void client.end({ timeout: 0 }).catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    await migrate(drizzle(client), { migrationsFolder: fileURLToPath(new URL("../momo-db/drizzle/", root)) });
    for (let index = 0; index < RESULT_NOTIFICATION_CONCURRENCY; index += 1) {
      signal.throwIfAborted();
      const value = payload(`capacity-retained-${index}`, true);
      const raw = JSON.stringify(value);
      const [size] = await client<{ bytes: number }[]>`SELECT octet_length(${raw}::jsonb::text) AS bytes`;
      if (!size || size.bytes > RESULT_NOTIFICATION_MAX_JSONB_BYTES) { throw new Error("Invalid capacity fixture size"); }
      // Claim/render do not read the immutable identity hash. The separate real
      // receipt below exercises canonicalization, identity, validation and insert.
      await client`INSERT INTO discord_notifications (id, family, kind, dedupe_key, schema_version, payload, payload_hash)
        VALUES (${value.notificationId}, 'result', 'analysis_completed', ${value.notificationId}, 1, ${raw}::jsonb, ${"0".repeat(64)})`;
      await client`INSERT INTO discord_notification_results (notification_id, kind, source_job_id, occurred_at, settings_generation)
        VALUES (${value.notificationId}, 'analysis_completed', ${value.sourceJobId}, ${value.occurredAt}, 0)`;
    }
  } finally { signal.removeEventListener("abort", abort); await client.end({ timeout: 5 }); }
};

const verify = async (): Promise<void> => {
  const image = process.argv[2];
  if (!image || process.argv.length !== 3 || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(image)) {
    throw new Error("Usage: TEST_DATABASE_URL=<local-test-db> pnpm verify:notification-capacity <local-image>");
  }
  const adminUrl = requireLocalTestUrl(process.env["TEST_DATABASE_URL"]).href;
  const configuration = await readFile(new URL("summit.config.example.yml", root), "utf8");
  const fly = await readFile(new URL("fly.toml", root), "utf8");
  const memoryValues = [...fly.matchAll(/^\s*memory\s*=\s*['"]([1-9][0-9]*)mb['"]\s*$/gm)];
  if (memoryValues.length !== 1 || !memoryValues[0]?.[1]) { throw new Error("Expected one Fly VM memory value in mb"); }
  const memoryMiB = Number(memoryValues[0][1]);
  if (!Number.isSafeInteger(memoryMiB) || memoryMiB > 8_192) { throw new Error("Invalid Fly memory capacity"); }
  const prefix = newDatabasePrefix();
  const database = `${prefix}_capacity`;
  const name = `summit-capacity-check-${randomUUID()}`;
  const token = randomUUID() + randomUUID();
  const admin = connect(adminUrl);
  const deadline = new AbortController();
  const timeout = setTimeout(() => deadline.abort(), 90_000);
  let containerStarted = false;
  let receiptRejected = false;
  let heapOutOfMemory = false;
  let result: unknown;
  try {
    // --pull=never also fails closed when the requested local image is absent.
    await docker(["image", "inspect", "--format", "{{.Id}}", image]);
    await admin`CREATE DATABASE ${admin(database)}`;
    const ownedUrl = databaseUrl(adminUrl, database);
    await prepareDatabase(ownedUrl, deadline.signal);
    const containerUrl = new URL(ownedUrl);
    containerUrl.hostname = "host.docker.internal";
    deadline.signal.throwIfAborted();
    const child = spawn("docker", ["run", "--pull=never", "--name", name, "--read-only", "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges", "--memory", `${memoryMiB}m`, "--memory-swap", `${memoryMiB}m`,
      ...(process.platform === "linux" ? ["--add-host", "host.docker.internal=host-gateway"] : []),
      "--publish", "127.0.0.1::8000", "--publish", "127.0.0.1::8001",
      "--env", "TZ=Asia/Tokyo", "--env", "DISCORD_TOKEN=offline-capacity-token",
      "--env", "DATABASE_URL", "--env", "SUMMIT_CONFIG_YAML", "--env", "PROBE_TOKEN",
      "--entrypoint", "node", "-i", image, "--expose-gc", "--input-type=module", "-"], {
      stdio: ["pipe", "pipe", "pipe"], signal: deadline.signal,
      env: { ...process.env, DATABASE_URL: containerUrl.href, SUMMIT_CONFIG_YAML: configuration, PROBE_TOKEN: token }
    });
    containerStarted = true;
    // Inspect only a bounded tail for V8 OOM classification; never print child
    // stderr, which may contain driver configuration or the submitted payload.
    let diagnosticTail = "";
    child.stderr.on("data", (chunk: Buffer) => {
      diagnosticTail = (diagnosticTail + chunk.toString()).slice(-2_048);
      heapOutOfMemory ||= /heap out of memory/i.test(diagnosticTail);
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject); child.once("exit", code => resolve(code));
    });
    // This rejection is observed again below; also cover an early exit while HTTP
    // work is pending so an abort never becomes an unhandled rejection.
    void exited.catch(() => undefined);
    child.stdin.on("error", () => undefined);
    child.stdin.end(notificationCapacityProbe);
    const ready = async (): Promise<void> => {
      const lines = createInterface({ input: child.stdout });
      try { for await (const line of lines) { if (line === "CAPACITY_READY") { return; } } }
      finally { lines.close(); }
      throw new Error("Capacity container exited before readiness");
    };
    await Promise.race([ready(), exited.then(() => { throw new Error("Capacity container exited before readiness"); })]);
    const origin = async (port: number): Promise<string> => {
      const address = await docker(["port", name, `${port}/tcp`]);
      if (!/^127\.0\.0\.1:[0-9]+$/.test(address)) { throw new Error("Expected an isolated loopback port"); }
      return `http://${address}`;
    };
    const receiptOrigin = await origin(8000);
    const measurementOrigin = await origin(8001);
    const value = payload("capacity-receipt", false);
    const raw = JSON.stringify(value);
    const jsonBytes = Buffer.byteLength(raw);
    const body = Buffer.from(raw + " ".repeat(RESULT_NOTIFICATION_MAX_BODY_BYTES - jsonBytes));
    const response = await fetch(`${receiptOrigin}/internal/discord-notifications`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body, signal: deadline.signal
    });
    if (response.status !== 200 && response.status !== 202) { receiptRejected = true; throw new Error("Receipt rejected"); }
    const receipt = z.object({ notificationId: z.literal(value.notificationId),
      disposition: z.enum(["accepted", "cancelled"]) }).parse(await response.json());
    const measured = await fetch(measurementOrigin, { headers: { authorization: `Bearer ${token}` }, signal: deadline.signal });
    const metrics = metricsSchema.parse(await measured.json());
    if (await exited !== 0 || metrics.cgroupPeak > memoryMiB * 1024 * 1024) { throw new Error("Capacity exceeded"); }
    result = { event: "notification_capacity.passed", memoryMiB, jsonBytes, wireBytes: body.byteLength,
      disposition: receipt.disposition, received: metrics.received, retained: metrics.retained, renderedParts: metrics.renderedParts,
      rssMiB: { baseline: metrics.baselineRss / 1024 / 1024, peak: metrics.peakRss / 1024 / 1024,
        maximum: metrics.maxRss / 1024 / 1024, cgroupPeak: metrics.cgroupPeak / 1024 / 1024 } };
  } catch {
    const state = containerStarted ? await docker(["inspect", "--format", "{{json .State}}", name]).catch(() => "null") : "null";
    const parsed = z.object({ OOMKilled: z.boolean() }).safeParse(JSON.parse(state));
    const oom = heapOutOfMemory || (parsed.success && parsed.data.OOMKilled);
    process.exitCode = oom ? 3 : deadline.signal.aborted ? 4 : receiptRejected ? 2 : 1;
    process.stderr.write(`Notification capacity verification failed: ${oom ? "oom" : deadline.signal.aborted ? "timeout" : receiptRejected ? "receipt_rejected" : "setup_or_measurement"}.\n`);
  } finally {
    clearTimeout(timeout);
    let cleanupFailed = false;
    if (containerStarted) { await docker(["rm", "--force", name]).catch(() => { cleanupFailed = true; }); }
    // CREATE DATABASE can commit before a lost response. IF EXISTS is safe for
    // this invocation's exact owned name even when creation was not acknowledged.
    try { await dropOwnedDatabase(admin, database, prefix); }
    catch { cleanupFailed = true; }
    finally { await admin.end({ timeout: 5 }); }
    if (cleanupFailed) { process.exitCode = 1; process.stderr.write("Capacity test cleanup failed.\n"); }
  }
  if (result !== undefined && !process.exitCode) { console.log(JSON.stringify(result)); }
};

await verify().catch(() => {
  // Never print driver/child-process errors: they may include connection values.
  process.stderr.write("Capacity verification requires a local image, TEST_DATABASE_URL, Docker and the sibling migrations.\n");
  process.exitCode = 1;
});
