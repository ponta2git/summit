import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { durationSummary, performanceScenarios } from "./notificationPerformance.contract.ts";
import { performanceMetrics } from "./notificationPerformance.metrics.ts";
import { summarizeCpuProfile, summarizeHeapProfile } from "./notificationPerformance.profileSummary.ts";

const sample = z.object({ kind: z.string(), status: z.number(), milliseconds: z.number(), barrierHeld: z.boolean() });
const runSchema = z.object({
  schemaVersion: z.literal(1), run: z.object({ scenario: z.enum(performanceScenarios), repetition: z.number(), profiled: z.boolean(),
    imageId: z.string(), postgresVersion: z.string() }),
  workload: z.object({ fixtureBytes: z.record(z.string(), z.object({ jsonBytes: z.number(), jsonbBytes: z.number(),
    nameCodePoints: z.number().optional() })), expectedNotifications: z.number(), completedParts: z.number(),
    barrierControlled: z.boolean(), warmupNotifications: z.number(), legacyJsonbBytes: z.number().optional() }),
  host: z.object({ elapsedMilliseconds: z.number(), httpSamples: z.array(sample) }), metrics: performanceMetrics,
  profiles: z.object({ cpu: z.string().optional(), heap: z.string().optional() }),
  verification: z.object({ passed: z.literal(true) })
});
type Run = z.infer<typeof runSchema> & { artifact: string };
const mib = (bytes: number): number => bytes / 1024 / 1024;
const total = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0);
const checkpoint = (run: Run, name: string) => {
  const value = run.metrics.checkpoints[name];
  if (!value) { throw new Error("Missing performance checkpoint"); }
  return value;
};
const runSummary = (run: Run) => ({
  artifact: run.artifact, repetition: run.run.repetition, profiled: run.run.profiled,
  elapsedMs: run.host.elapsedMilliseconds, telemetryWindowMs: run.metrics.window.elapsedMs,
  notifications: run.workload.expectedNotifications, parts: run.workload.completedParts,
  notificationsPerSecond: run.workload.expectedNotifications * 1000 / run.host.elapsedMilliseconds,
  partsPerSecond: run.workload.completedParts * 1000 / run.host.elapsedMilliseconds,
  memoryMiB: { cgroupPeak: mib(run.metrics.cgroupPeak), maxRss: mib(run.metrics.maxRss),
    heapUsedPeak: mib(run.metrics.memory.peak.heapUsed), externalPeak: mib(run.metrics.memory.peak.external),
    arrayBuffersPeak: mib(run.metrics.memory.peak.arrayBuffers), warmHeap: mib(checkpoint(run, "warm").heapUsed),
    postGcHeap: mib(run.metrics.finalization.postGc.heapUsed),
    postGcHeapGrowth: mib(run.metrics.finalization.postGc.heapUsed - checkpoint(run, "warm").heapUsed),
    finalizationCgroupPeak: mib(run.metrics.finalization.postSerialization.cgroupPeak) },
  cpuMs: { user: run.metrics.cpu.userMicros / 1000, system: run.metrics.cpu.systemMicros / 1000 },
  cpuPercentOfOneCore: (run.metrics.cpu.userMicros + run.metrics.cpu.systemMicros) / run.metrics.window.elapsedMs / 10,
  throttledMs: (run.metrics.cpu.cgroupDelta["throttled_usec"] ?? 0) / 1000,
  eventLoop: run.metrics.eventLoop, gc: { count: run.metrics.gc.count, totalMs: run.metrics.gc.totalMs, maxMs: run.metrics.gc.maxMs },
  heapSpaces: { warm: checkpoint(run, "warm").heapSpaceStats, postGc: run.metrics.finalization.postGc.heapSpaceStats },
  observationCounts: run.metrics.retainedObservationCounts,
  maxClaimBatchBytes: run.metrics.maxClaimBatchBytes, maxActivePayloadBytes: run.metrics.maxActivePayloadBytes,
  maxPendingReceipts: run.metrics.maxPendingReceipts, maxPendingSends: run.metrics.maxPendingSends
});

const partDeciles = (runs: readonly Run[]) => Array.from({ length: 10 }, (_, decile) => {
  const operations = Object.fromEntries((["begin", "complete"] as const).map(operation => {
    const values = runs.flatMap(run => {
      const counts = new Map(run.metrics.completedNotifications.map(value => [value.notificationOrdinal, value.parts]));
      return run.metrics.partOperations[operation].filter(value => {
        const count = counts.get(value.notificationOrdinal);
        if (!count) { throw new Error("Missing notification part count"); }
        return Math.min(9, Math.floor(value.partNo / count * 10)) === decile;
      }).map(value => value.durationMs);
    });
    return [operation, durationSummary(values)];
  }));
  return { fromPercent: decile * 10, toPercent: (decile + 1) * 10, ...operations };
});

// Preserve each bucket's maximum rather than silently hiding sampled peaks.
const memoryTrace = (run: Run) => {
  const samples = run.metrics.memorySamples;
  const width = Math.max(1, Math.ceil(samples.length / 500));
  const values = [];
  for (let start = 0; start < samples.length; start += width) {
    const bucket = samples.slice(start, start + width);
    values.push({ elapsedSeconds: bucket.at(-1)!.elapsedMs / 1000, samples: bucket.length,
      cgroupMiB: mib(Math.max(...bucket.map(value => value.cgroupCurrent))),
      rssMiB: mib(Math.max(...bucket.map(value => value.rss))),
      heapUsedMiB: mib(Math.max(...bucket.map(value => value.heapUsed))),
      externalMiB: mib(Math.max(...bucket.map(value => value.external))) });
  }
  return { artifact: run.artifact, aggregation: "maximum_per_bucket", values };
};

const analyze = async (): Promise<void> => {
  const [directory, output, ...extra] = process.argv.slice(2);
  if (!directory || !output || extra.length) { throw new Error("Usage: notificationPerformance.analyze.ts <artifact-directory> <new-summary.json>"); }
  const names = (await readdir(directory)).sort();
  const completion = z.object({ runs: z.array(z.object({ artifact: z.string() })) })
    .parse(JSON.parse(await readFile(join(directory, "summary.json"), "utf8")));
  if (names.includes("failure.json")) { throw new Error("Measurement directory contains a failure"); }
  const runs: Run[] = [];
  const hashes = [];
  const provenance = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as unknown;
  for (const name of names) {
    if (!/^(manifest\.json|[a-z]+-(?:[0-9]{2}|profile)\.(?:json|cpuprofile|heapprofile))$/.test(name)) { continue; }
    const data = await readFile(join(directory, name));
    hashes.push({ artifact: name, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") });
    if (/^[a-z]+-(?:[0-9]{2}|profile)\.json$/.test(name)) {
      runs.push({ ...runSchema.parse(JSON.parse(data.toString())), artifact: name });
    }
  }
  if (!runs.length) { throw new Error("No completed measurements"); }
  if (completion.runs.length !== runs.length || new Set(completion.runs.map(run => run.artifact)).size !== runs.length
    || completion.runs.some(run => !runs.some(value => value.artifact === run.artifact))) {
    throw new Error("Incomplete measurement artifacts");
  }
  const scenarios = [];
  for (const scenario of performanceScenarios) {
    const baseline = runs.filter(run => run.run.scenario === scenario && !run.run.profiled);
    if (!baseline.length) { continue; }
    const sorted = [...baseline].sort((left, right) => left.host.elapsedMilliseconds - right.host.elapsedMilliseconds);
    const representative = sorted[Math.floor(sorted.length / 2)]!;
    const httpSamples = baseline.flatMap(run => run.host.httpSamples);
    const http = Object.fromEntries([...new Set(httpSamples.map(value => `${value.kind}:${value.status}:${value.barrierHeld ? "held" : "unheld"}`))].map(key => [key,
      durationSummary(httpSamples.filter(value => key === `${value.kind}:${value.status}:${value.barrierHeld ? "held" : "unheld"}`).map(value => value.milliseconds))]));
    const operations = Object.fromEntries([...new Set(baseline.flatMap(run => Object.keys(run.metrics.operationDurationsMs)))].map(key =>
      [key, durationSummary(baseline.flatMap(run => run.metrics.operationDurationsMs[key] ?? []))]));
    const latencies = Object.fromEntries(Object.keys(representative.metrics.notificationLatencyMs).map(key => [key,
      durationSummary(baseline.flatMap(run => run.metrics.notificationLatencyMs[key as keyof typeof run.metrics.notificationLatencyMs]))]));
    const profiles = [];
    for (const run of runs.filter(value => value.run.scenario === scenario && value.run.profiled)) {
      if (!run.profiles.cpu || !run.profiles.heap) { throw new Error("Missing profile artifact"); }
      // Artifact names are restricted to the same directory by the producer contract.
      if (![run.profiles.cpu, run.profiles.heap].every(name => /^[a-z]+-profile\.(cpuprofile|heapprofile)$/.test(name))) {
        throw new Error("Invalid profile artifact name");
      }
      const cpu = summarizeCpuProfile(JSON.parse(await readFile(join(directory, run.profiles.cpu), "utf8")));
      const heap = summarizeHeapProfile(JSON.parse(await readFile(join(directory, run.profiles.heap), "utf8")));
      profiles.push({ ...runSummary(run), recording: run.metrics.profileMode,
        elapsedRatioToBaselineMedian: run.host.elapsedMilliseconds / representative.host.elapsedMilliseconds,
        cpu: { ...cpu, functions: cpu.functions.slice(0, 40) }, heap: { ...heap, functions: heap.functions.slice(0, 40) } });
    }
    scenarios.push({ scenario, repetitions: baseline.length, fixture: representative.workload,
      baseline: baseline.map(runSummary), elapsedMs: durationSummary(baseline.map(run => run.host.elapsedMilliseconds)),
      throughputPartsPerSecond: total(baseline.map(run => run.workload.completedParts)) * 1000 / total(baseline.map(run => run.host.elapsedMilliseconds)),
      http, operations, latencies, partDeciles: partDeciles(baseline), representativeMemory: memoryTrace(representative), profiles });
  }
  await writeFile(output, JSON.stringify({ schemaVersion: 1, provenance, hashes, scenarios,
    interpretation: { percentileMethod: "nearest-rank over pooled raw observations; event-loop histograms remain per-run",
      profilesExcludedFromBaseline: true, samplingHeapMeasures: "estimated cumulative allocation including collected objects",
      postGcHeapIncludesRecorderArrays: true, memoryTrace: "at most 500 bucket maxima from 50ms samples" } }, null, 2) + "\n", { flag: "wx" });
  console.log(`Analyzed ${runs.length} runs across ${scenarios.length} scenarios.`);
};

await analyze();
