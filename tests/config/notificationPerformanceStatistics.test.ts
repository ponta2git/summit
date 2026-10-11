import { describe, expect, it } from "vitest";
import { summarizePartDeciles, summarizePerformanceTimings } from "../../scripts/perf/notificationPerformance.statistics.ts";

type TimingMetrics = Parameters<typeof summarizePerformanceTimings>[0][number];
type Notification = TimingMetrics["completedNotifications"][number];
const notification = (values: Partial<Notification> = {}): Notification => ({
  notificationOrdinal: 1, parts: 1, payloadBytes: 100, origin: "receipt",
  receiptToFirstSendMs: null, receiptToCompleteMs: null, claimToFirstSendMs: null,
  claimToCompleteMs: null, firstSendToCompleteMs: null, ...values
});
const timings = (operations: TimingMetrics["operationDurationsMs"], completed: Notification[] = []): TimingMetrics => ({
  operationDurationsMs: operations, completedNotifications: completed,
  notificationLatencyMs: { receiptToFirstSend: [], receiptToComplete: [], claimToFirstSend: [], claimToComplete: [], firstSendToComplete: [] }
});
const part = (partNo: number, durationMs: number) => ({ notificationOrdinal: 1, partNo, durationMs, failed: false });

describe("notification performance aggregation", () => {
  it("pools raw observations rather than averaging per-run percentiles", () => {
    const result = summarizePerformanceTimings([
      timings({ begin: [1, 2, 3], constructor: [8], empty: [] }), timings({ begin: [100], complete: [4] })
    ]);
    expect(result.operations["begin"]).toMatchObject({ count: 4, p50: 2, p95: 100, mean: 26.5 });
    expect(result.operations["complete"]).toMatchObject({ count: 1, p50: 4 });
    expect(result.operations["constructor"]).toMatchObject({ count: 1, p50: 8 });
    expect(result.operations["empty"]).toMatchObject({ count: 0, p50: null });
  });

  it("keeps kinds separate and excludes missing legacy or seeded receipt observations", () => {
    const result = summarizePerformanceTimings([timings({}, [
      notification({ kind: "ocr_completed", queueWaitMs: 0, receiptToCompleteMs: 10 }),
      notification({ kind: "analysis_completed", queueWaitMs: 4, receiptToCompleteMs: 40 }),
      notification({ kind: "analysis_completed", origin: "seeded_claim", claimToCompleteMs: 90 }),
      notification({ queueWaitMs: 999, receiptToCompleteMs: 999 })
    ])]);
    expect(result.latencyByKind.ocr_completed.queueWaitMs).toMatchObject({ count: 1, p50: 0 });
    expect(result.latencyByKind.ocr_completed.receiptToCompleteMs).toMatchObject({ count: 1, p50: 10 });
    expect(result.latencyByKind.analysis_completed.receiptToCompleteMs).toMatchObject({ count: 1, p50: 40 });
    expect(result.latencyByKind.analysis_completed.claimToCompleteMs).toMatchObject({ count: 1, p50: 90 });
    expect(result.latencyByKind.analysis_completed.queueWaitMs).toMatchObject({ count: 1, p50: 4 });
  });

  it("uses each run's plan when notification ordinals repeat, retaining empty deciles", () => {
    const result = summarizePartDeciles([
      { completedNotifications: [notification({ parts: 2 })], partOperations: { begin: [part(0, 1), part(1, 9)], complete: [part(1, 12)] } },
      { completedNotifications: [notification({ parts: 20 })], partOperations: { begin: [part(1, 3), part(19, 20)], complete: [] } }
    ]);
    expect(result).toHaveLength(10);
    expect(result[0]?.begin).toMatchObject({ count: 2, mean: 2 });
    expect(result[5]).toMatchObject({ fromPercent: 50, toPercent: 60, begin: { count: 1, p50: 9 }, complete: { count: 1, p50: 12 } });
    expect(result[9]?.begin).toMatchObject({ count: 1, p50: 20 });
    expect(result[4]?.begin).toMatchObject({ count: 0, p50: null });
  });

  it("rejects a part without a corresponding completed plan", () => {
    expect(() => summarizePartDeciles([{ completedNotifications: [], partOperations: { begin: [part(0, 1)], complete: [] } }]))
      .toThrow("Missing notification part count");
  });
});
