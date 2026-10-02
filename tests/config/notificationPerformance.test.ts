import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter, getEventListeners } from "node:events";
import { performanceOptions, durationSummary, performanceStage } from "../../scripts/perf/notificationPerformance.contract.ts";
import { createPerformanceOutput, withPerformanceDatabase, writePerformanceArtifact } from "../../scripts/perf/notificationPerformance.storage.ts";
import { cpuProfileSchema, heapProfileSchema, performanceMetrics } from "../../scripts/perf/notificationPerformance.metrics.ts";
import { withCapacityContainer } from "../../scripts/verify/notificationCapacity.container.ts";
import { performanceFailure } from "../../scripts/perf/notificationPerformance.diagnostics.ts";
import { CapacityError } from "../../scripts/verify/notificationCapacity.contract.ts";
import assert from "node:assert/strict";
import { z } from "zod";
import { withPerformanceCancellation } from "../../scripts/perf/notificationPerformance.cancellation.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe("notification performance harness", () => {
  it("keeps timing runs separate from an optional profile run", () => {
    const options = performanceOptions(["summit:perf", "--output", "/tmp/summit-perf", "--scenario", "normal", "--profile"]);
    expect(options).toStrictEqual({ image: "summit:perf", output: "/tmp/summit-perf", repetitions: 3, rounds: 10,
      scenarios: ["normal"], profile: true, profileOnly: false });
    expect(performanceOptions(["summit:perf", "--output", "/tmp/summit-perf", "--repetitions", "1", "--rounds", "2"]).scenarios)
      .toStrictEqual(["normal", "unicode", "markdown", "parts", "overlap", "legacy", "soak"]);
  });

  it("allows profile-only runs without baseline repetitions or the profile flag", () => {
    expect(performanceOptions(["summit:perf", "--output", "/tmp/profiles", "--profile-only"]))
      .toMatchObject({ profile: false, profileOnly: true, repetitions: 3,
        scenarios: ["normal", "unicode", "markdown", "parts", "overlap", "legacy", "soak"] });
    expect(performanceOptions(["summit:perf", "--output", "/tmp/profiles", "--scenario", "legacy", "--profile-only"]).scenarios)
      .toStrictEqual(["legacy"]);
  });

  it.each([
    [], ["--privileged"], ["summit:perf"], ["summit:perf", "--output"],
    ["summit:perf", "--output", "/tmp/result", "--scenario", "production"],
    ["summit:perf", "--output", "/tmp/result", "--repetitions", "0"],
    ["summit:perf", "--output", "/tmp/result", "--repetitions", "11"],
    ["summit:perf", "--output", "/tmp/result", "--rounds", "1.5"],
    ["summit:perf", "--output", "/tmp/result", "--rounds", "51"],
    ["summit:perf", "--output", "/tmp/result", "--profile", "--profile"],
    ["summit:perf", "--output", "/tmp/result", "--profile-only", "--profile"],
    ["summit:perf", "--output", "/tmp/result", "--profile-only", "--repetitions", "1"]
  ].map(args => ({ args })))("refuses unbounded or ambiguous options: $args", ({ args }) => {
    expect(() => performanceOptions(args)).toThrow("setup_or_measurement");
  });

  it("reports observed nearest-rank tails and preserves the input order", () => {
    const values = Array.from({ length: 20 }, (_, index) => 20 - index);
    expect(durationSummary(values)).toStrictEqual({ count: 20, min: 1, max: 20, mean: 10.5,
      p50: 10, p95: 19, p99: 20, smallTailSample: true });
    expect(values[0]).toBe(20);
    expect(durationSummary([]).p99).toBeNull();
    expect(() => durationSummary([Number.NaN])).toThrow("setup_or_measurement");
    expect(() => durationSummary([-1])).toThrow("setup_or_measurement");
  });

  it("creates fresh artifacts and refuses both overwrites and path traversal", async () => {
    const parent = await mkdtemp(join(tmpdir(), "summit-performance-test-")); directories.push(parent);
    const directory = join(parent, "run");
    await createPerformanceOutput(directory);
    await writePerformanceArtifact(directory, "normal-01.json", { count: 2 });
    expect(JSON.parse(await readFile(join(directory, "normal-01.json"), "utf8"))).toStrictEqual({ count: 2 });
    await expect(createPerformanceOutput(directory)).rejects.toThrow("EEXIST");
    await expect(writePerformanceArtifact(directory, "normal-01.json", { count: 9 })).rejects.toMatchObject({
      detail: "persist", diagnostic: { systemCode: "EEXIST" }
    });
    await expect(writePerformanceArtifact(directory, "../outside.json", {})).rejects.toThrow("setup_or_measurement");
  });

  it("keeps diagnostic errors static instead of exposing driver or request text", async () => {
    await expect(performanceStage("database_setup", async () => { throw new Error("postgres://credential@example.invalid"); }))
      .rejects.toMatchObject({ message: "setup_or_measurement", detail: "database_setup" });
  });

  it("preserves inner capacity details through nested orchestration", async () => {
    const error = new CapacityError("setup_or_measurement", "control_finish_status_500");
    await expect(performanceStage("container", () => performanceStage("workload", async () => { throw error; }))).rejects.toBe(error);
  });

  it("records numeric assertion evidence without messages or object values", async () => {
    const secret = "do-not-export-authorization";
    const numeric = await performanceStage("metrics_contract", async () => { assert.equal(8_822, 8_823, secret); })
      .then(() => undefined, performanceFailure);
    expect(numeric).toMatchObject({ stage: "metrics_contract", diagnostic: { kind: "assertion", actual: 8_822, expected: 8_823 } });
    const objects = await performanceStage("metrics_contract", async () => { assert.deepEqual({ token: secret }, {}, secret); })
      .then(() => undefined, performanceFailure);
    expect(objects).toMatchObject({ diagnostic: { kind: "assertion", actualType: "object", expectedType: "object" } });
    expect(JSON.stringify([numeric, objects])).not.toContain(secret);
  });

  it("retains only fixed schema paths and codes, including redaction of record keys", async () => {
    const secret = "private-credential-and-payload";
    const failure = await performanceStage("result", () => performanceStage("metrics_schema", async () => {
      z.object({ memory: z.record(z.string(), z.number()) }).parse({ memory: { [secret]: secret } });
    })).then(() => undefined, performanceFailure);
    expect(failure).toMatchObject({ stage: "metrics_schema", diagnostic: { kind: "schema",
      issues: [{ path: ["memory", "[key]"], code: "invalid_type" }] } });
    expect(JSON.stringify(failure)).not.toContain(secret);
  });

  it("identifies fetch socket termination without logging cause messages", async () => {
    const cause = Object.assign(new Error("postgres://private-credential@host"), { code: "UND_ERR_SOCKET" });
    const failure = await performanceStage("control_finish", async () => { throw new TypeError("response included private payload", { cause }); })
      .then(() => undefined, performanceFailure);
    expect(failure).toMatchObject({ stage: "control_finish", diagnostic: { kind: "exception", name: "TypeError", systemCode: "UND_ERR_SOCKET" } });
    expect(JSON.stringify(failure)).not.toContain("private");
  });

  it("rejects secret-bearing container overrides before attempting Docker", async () => {
    await expect(withCapacityContainer({ image: "unused", memoryMiB: 256, databaseUrl: "unused", configuration: "unused",
      scenario: "standard", env: { DATABASE_URL: "forbidden" } }, async () => undefined)).rejects.toThrow("setup_or_measurement");
    await expect(withCapacityContainer({ image: "unused", memoryMiB: 256, databaseUrl: "unused", configuration: "unused",
      scenario: "standard", cpus: 0 }, async () => undefined)).rejects.toThrow("setup_or_measurement");
  });

  it.each(["SIGINT", "SIGTERM"] as const)("waits for owned cleanup once after %s and removes its listeners", async firstSignal => {
    const signals = new EventEmitter();
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>(resolve => { releaseCleanup = resolve; });
    let cleanupCalls = 0;
    let settled = false;
    const result = withPerformanceCancellation(async signal => {
      try {
        await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
        signal.throwIfAborted();
      } finally { cleanupCalls++; await cleanup; }
    }, signals).then(() => { settled = true; return undefined; }, error => { settled = true; return error as unknown; });
    expect(signals.listenerCount("SIGINT")).toBe(1);
    expect(signals.listenerCount("SIGTERM")).toBe(1);
    signals.emit(firstSignal);
    await Promise.resolve();
    signals.emit(firstSignal === "SIGINT" ? "SIGTERM" : "SIGINT");
    expect(cleanupCalls).toBe(1);
    expect(settled).toBe(false);
    releaseCleanup();
    expect(await result).toMatchObject({ code: "setup_or_measurement", detail: `interrupted_${firstSignal.toLowerCase()}` });
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("does not report success when a workload returns after interruption", async () => {
    const signals = new EventEmitter();
    await expect(withPerformanceCancellation(async () => { signals.emit("SIGINT"); return "finished"; }, signals))
      .rejects.toMatchObject({ code: "setup_or_measurement", detail: "interrupted_sigint" });
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("preserves unrelated signal listeners after successful and failed work", async () => {
    const signals = new EventEmitter();
    const existing = () => undefined;
    signals.on("SIGINT", existing); signals.on("SIGTERM", existing);
    expect(await withPerformanceCancellation(async () => 7, signals)).toBe(7);
    const failure = new CapacityError("setup_or_measurement", "workload");
    await expect(withPerformanceCancellation(async () => { throw failure; }, signals)).rejects.toBe(failure);
    expect(signals.listeners("SIGINT")).toStrictEqual([existing]);
    expect(signals.listeners("SIGTERM")).toStrictEqual([existing]);
  });

  it("rejects an already interrupted run before Docker or database work", async () => {
    const controller = new AbortController();
    const failure = new CapacityError("setup_or_measurement", "interrupted_sigterm");
    controller.abort(failure);
    const never = async () => { throw new Error("must not run"); };
    await expect(withCapacityContainer({ image: "unused", memoryMiB: 256, databaseUrl: "unused", configuration: "unused",
      scenario: "standard", signal: controller.signal }, never)).rejects.toBe(failure);
    await expect(withPerformanceDatabase("unused", never, { signal: controller.signal })).rejects.toBe(failure);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("rejects missing measurements and failed instrumentation", () => {
    const schema = performanceMetrics.pick({ protocolFailures: true, applicationErrors: true, sampleFailures: true, droppedSamples: true });
    expect(schema.safeParse({ protocolFailures: 0, applicationErrors: 0, sampleFailures: 0, droppedSamples: 0 }).success).toBe(true);
    expect(schema.safeParse({ protocolFailures: 0, applicationErrors: 0, sampleFailures: 1, droppedSamples: 0 }).success).toBe(false);
    expect(schema.safeParse({ protocolFailures: 0, applicationErrors: 0, droppedSamples: 0 }).success).toBe(false);
  });

  it("exports only inspector profile fields rather than arbitrary probe metadata", () => {
    const callFrame = { functionName: "test", scriptId: "1", url: "file:///app/test.js", lineNumber: 0, columnNumber: 0 };
    const cpu = cpuProfileSchema.parse({ startTime: 0, endTime: 1, nodes: [{ id: 1, callFrame, secret: "discard" }],
      samples: [1], timeDeltas: [1], authorization: "discard" });
    const heap = heapProfileSchema.parse({ head: { id: 1, selfSize: 64, callFrame, children: [], payload: "discard" },
      samples: [{ size: 64, nodeId: 1, ordinal: 1 }], token: "discard" });
    expect(JSON.stringify({ cpu, heap })).not.toContain("discard");
  });
});
