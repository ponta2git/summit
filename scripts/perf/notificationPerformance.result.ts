import assert from "node:assert/strict";
import { z } from "zod";
import { durationSummary, performanceStage, type PerformanceScenario } from "./notificationPerformance.contract.ts";
import { cpuProfileSchema, heapProfileSchema, performanceMetrics } from "./notificationPerformance.metrics.ts";
import { writePerformanceArtifact } from "./notificationPerformance.storage.ts";
import type { runPerformanceScenario } from "./notificationPerformance.scenarios.ts";

export const savePerformanceResult = async (directory: string, filename: string, run: {
  readonly scenario: PerformanceScenario; readonly repetition: number; readonly profiled: boolean;
  readonly rounds: number; readonly imageId: string; readonly postgresVersion: string;
}, result: Awaited<ReturnType<typeof runPerformanceScenario>>) => {
  const metrics = await performanceStage("metrics_schema", async () => performanceMetrics.parse(result.rawProbe));
  const expectedConflicts = result.httpSamples.filter(sample => sample.kind === "conflict" && sample.status === 409).length;
  const heapBaseline = await performanceStage("metrics_contract", async () => {
    const baseline = metrics.checkpoints["warm"] ?? metrics.checkpoints["baseline"];
    assert.ok(baseline);
    assert.equal(metrics.profileMode.enabled, run.profiled);
    assert.equal(metrics.sentParts, metrics.partOperations.begin.length);
    assert.equal(metrics.sentParts, metrics.partOperations.complete.length);
    assert.equal(metrics.deliveredNotifications, metrics.completedNotifications.length);
    assert.ok(metrics.partOperations.begin.every(part => !part.failed));
    assert.ok(metrics.partOperations.complete.every(part => !part.failed));
    assert.deepEqual(metrics.operationErrors, expectedConflicts ? { receive: expectedConflicts, receiveTotal: expectedConflicts } : {});
    for (const [operation, count] of Object.entries(metrics.operationCounts)) {
      assert.equal(metrics.operationDurationsMs[operation]?.length, count);
    }
    return baseline;
  });
  const profiles = await performanceStage("profile_schema", async () =>
    z.object({ cpuProfile: z.unknown(), heapProfile: z.unknown() }).parse(result.rawProbe));
  const profileArtifacts: { cpu?: string; heap?: string } = {};
  if (run.profiled) {
    const { cpu, heap } = await performanceStage("profile_schema", async () => ({
      cpu: cpuProfileSchema.parse(profiles.cpuProfile), heap: heapProfileSchema.parse(profiles.heapProfile)
    }));
    await performanceStage("profile_contract", async () => {
      assert.ok(cpu.nodes.length > 0 && (cpu.samples?.length ?? 0) > 0);
      assert.ok(heap.head.children.length > 0 && heap.samples.length > 0);
    });
    profileArtifacts.cpu = `${filename}.cpuprofile`; profileArtifacts.heap = `${filename}.heapprofile`;
    await writePerformanceArtifact(directory, profileArtifacts.cpu, cpu);
    await writePerformanceArtifact(directory, profileArtifacts.heap, heap);
  } else {
    await performanceStage("profile_contract", async () => { assert.equal(profiles.cpuProfile, null); assert.equal(profiles.heapProfile, null); });
  }
  const httpLatencyMs = Object.fromEntries((["analysis", "ocr", "conflict", "overload"] as const).map(kind => [kind, {
    unheld: durationSummary(result.httpSamples.filter(sample => sample.kind === kind && !sample.barrierHeld).map(sample => sample.milliseconds)),
    barrierHeld: durationSummary(result.httpSamples.filter(sample => sample.kind === kind && sample.barrierHeld).map(sample => sample.milliseconds))
  }]));
  const operations = Object.fromEntries(Object.entries(metrics.operationDurationsMs).map(([key, values]) => [key, durationSummary(values)]));
  const notificationLatencyMs = Object.fromEntries(Object.entries(metrics.notificationLatencyMs).map(([key, values]) => [key, durationSummary(values)]));
  const artifact = { schemaVersion: 1, run: { ...run, memoryMiB: 256, cpus: 1, swapMiB: 0 },
    workload: result.workload, host: { ...result.host, httpSamples: result.httpSamples, httpLatencyMs },
    metrics, statistics: { percentileMethod: "nearest-rank", operations, notificationLatencyMs }, profiles: profileArtifacts,
    verification: { passed: true, protocolFailures: 0, sampleFailures: 0, droppedSamples: 0,
      expectedIdentityConflicts: expectedConflicts, applicationErrors: 0 } };
  await writePerformanceArtifact(directory, `${filename}.json`, artifact);
  const summary = { artifact: `${filename}.json`, ...artifact.run, delivered: metrics.deliveredNotifications,
    sentParts: metrics.sentParts, elapsedMilliseconds: result.host.elapsedMilliseconds,
    throughputNotificationsPerSecond: metrics.deliveredNotifications / (result.host.elapsedMilliseconds / 1_000),
    barrierControlled: result.workload.barrierControlled, cgroupPeakMiB: metrics.cgroupPeak / 1024 / 1024,
    peakRssMiB: metrics.peakRss / 1024 / 1024, peakHeapMiB: metrics.memory.peak.heapUsed / 1024 / 1024,
    postGcHeapGrowthBytes: metrics.finalization.postGc.heapUsed - heapBaseline.heapUsed,
    postGcIncludesProfileObjects: metrics.finalization.postGcIncludesProfileObjects,
    cpuUserMilliseconds: metrics.cpu.userMicros / 1_000, cpuSystemMilliseconds: metrics.cpu.systemMicros / 1_000,
    eventLoop: metrics.eventLoop, gc: { count: metrics.gc.count, totalMs: metrics.gc.totalMs, maxMs: metrics.gc.maxMs },
    httpLatencyMs, notificationLatencyMs, operations };
  console.log(JSON.stringify({ event: "notification_performance.completed", scenario: run.scenario, repetition: run.repetition,
    profiled: run.profiled, elapsedMilliseconds: summary.elapsedMilliseconds, cgroupPeakMiB: summary.cgroupPeakMiB,
    completedParts: summary.sentParts, artifact: `${filename}.json` }));
  return summary;
};
