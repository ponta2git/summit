import type { z } from "zod";
import { durationSummary } from "./notificationPerformance.contract.ts";
import type { performanceMetrics } from "./notificationPerformance.metrics.ts";

type Metrics = z.infer<typeof performanceMetrics>;
type DurationStatistics = ReturnType<typeof durationSummary>;
type Durations = Readonly<Record<string, readonly number[]>>;
type TimingMetrics = Pick<Metrics, "operationDurationsMs" | "notificationLatencyMs" | "completedNotifications">;
type LatencyField = "queueWaitMs" | "receiptToFirstSendMs" | "receiptToCompleteMs" | "claimToCompleteMs";
type KindLatency = Record<LatencyField, DurationStatistics>;
interface TimingSummary {
  readonly operations: Record<string, DurationStatistics>;
  readonly notificationLatencyMs: Record<string, DurationStatistics>;
  readonly latencyByKind: { readonly ocr_completed: KindLatency; readonly analysis_completed: KindLatency };
}

const summarizePooledDurations = (groups: readonly Durations[]): Record<string, DurationStatistics> => {
  const pooled = new Map<string, number[]>();
  for (const group of groups) {
    for (const [key, values] of Object.entries(group)) {
      const bucket = pooled.get(key) ?? [];
      pooled.set(key, bucket);
      for (const value of values) { bucket.push(value); }
    }
  }
  return Object.fromEntries([...pooled].map(([key, values]) => [key, durationSummary(values)]));
};

/** Use the same pooled observations for single-run artifacts and multi-run reports.
 * Missing legacy fields and seeded receipt timings are not zero-duration samples. */
export const summarizePerformanceTimings = (runs: readonly TimingMetrics[]): TimingSummary => {
  const notifications = runs.flatMap(run => run.completedNotifications);
  const byKind = (kind: "ocr_completed" | "analysis_completed"): KindLatency => {
    const values = notifications.filter(value => value.kind === kind);
    const summarize = (key: LatencyField): DurationStatistics => durationSummary(
      values.flatMap(value => value[key] === null || value[key] === undefined ? [] : [value[key]])
    );
    return { queueWaitMs: summarize("queueWaitMs"), receiptToFirstSendMs: summarize("receiptToFirstSendMs"),
      receiptToCompleteMs: summarize("receiptToCompleteMs"), claimToCompleteMs: summarize("claimToCompleteMs") };
  };
  return {
    operations: summarizePooledDurations(runs.map(run => run.operationDurationsMs)),
    notificationLatencyMs: summarizePooledDurations(runs.map(run => run.notificationLatencyMs)),
    latencyByKind: { ocr_completed: byKind("ocr_completed"), analysis_completed: byKind("analysis_completed") }
  };
};

/** Group each part once, using its notification's plan within the same run. */
export const summarizePartDeciles = (
  runs: readonly Pick<Metrics, "completedNotifications" | "partOperations">[]
): readonly { fromPercent: number; toPercent: number; begin: DurationStatistics; complete: DurationStatistics }[] => {
  const buckets = Array.from({ length: 10 }, (): { begin: number[]; complete: number[] } => ({ begin: [], complete: [] }));
  for (const run of runs) {
    const counts = new Map(run.completedNotifications.map(value => [value.notificationOrdinal, value.parts]));
    for (const operation of ["begin", "complete"] as const) {
      for (const part of run.partOperations[operation]) {
        const count = counts.get(part.notificationOrdinal);
        if (!count) { throw new Error("Missing notification part count"); }
        buckets[Math.min(9, Math.floor(part.partNo / count * 10))]![operation].push(part.durationMs);
      }
    }
  }
  return buckets.map((bucket, index) => ({ fromPercent: index * 10, toPercent: (index + 1) * 10,
    begin: durationSummary(bucket.begin), complete: durationSummary(bucket.complete) }));
};
