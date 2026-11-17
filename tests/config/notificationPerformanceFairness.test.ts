import { describe, expect, it } from "vitest";
import { assertLegacyQueueOrder, runFairnessScenario } from "../../scripts/perf/notificationPerformance.fairness.ts";

const createHarness = () => {
  const events: string[] = [];
  return {
    events,
    control: async (path: string) => {
      events.push(path);
      return path === "/stats" ? { sentPartsByKind: { analysis_completed: 2 } } : {};
    },
    post: async (_value: unknown, kind: "analysis" | "ocr") => { events.push(`post:${kind}`); },
    seedLegacy: async () => { events.push("seed:legacy"); return 8_000_000; },
    analysis: () => ({}), ocr: () => ({})
  };
};

describe("notification fairness measurement", () => {
  it("records a short stream observation without treating two completed initial posts as a failure", async () => {
    const harness = createHarness();
    const result = await runFairnessScenario({ ...harness, scenario: "stream", rounds: 1 });
    expect(result).toMatchObject({ expectedNotifications: 4, analysisPartsAtArrivalEnd: 2, syntheticSendDelayMs: 5 });
    expect(harness.events).toEqual(["/send-delay/5", "/hold-delivery", "post:analysis", "post:analysis", "/wait/sends/2",
      "post:ocr", "/release-delivery", "post:ocr", "/stats", "/wait/delivered/4"]);
  });

  it("puts each mixed OCR behind two already started analyses and waits for each round to finish", async () => {
    const harness = createHarness();
    const result = await runFairnessScenario({ ...harness, scenario: "mixed", rounds: 2 });
    expect(result.expectedNotifications).toBe(6);
    expect(harness.events).toEqual(["/send-delay/0", "/hold-delivery", "post:analysis", "post:analysis", "/wait/sends/2",
      "post:ocr", "/release-delivery", "/wait/delivered/3", "/hold-delivery", "post:analysis", "post:analysis", "/wait/sends/2",
      "post:ocr", "/release-delivery", "/wait/delivered/6"]);
  });

  it("queues the legacy payload before the later OCR while the first OCR still holds its slot", async () => {
    const harness = createHarness();
    const result = await runFairnessScenario({ ...harness, scenario: "legacyqueue", rounds: 1 });
    expect(result).toMatchObject({ expectedNotifications: 3, legacyJsonbBytes: 8_000_000 });
    expect(harness.events).toEqual(["/hold-delivery", "post:ocr", "/wait/sends/1", "seed:legacy", "post:ocr",
      "/release-delivery", "/wait/delivered/3"]);
  });

  it("rejects legacy overtaking or interleaving visible in completion order", () => {
    const first = { notificationOrdinal: 1, kind: "ocr_completed", origin: "receipt" };
    const later = { notificationOrdinal: 2, kind: "ocr_completed", origin: "receipt" };
    const legacy = { notificationOrdinal: 3, kind: "analysis_completed", origin: "seeded_claim" };
    expect(() => assertLegacyQueueOrder({ maxActivePayloadBytes: 8_000_000, completedNotifications: [first, legacy, later] }, 8_000_000)).not.toThrow();
    expect(() => assertLegacyQueueOrder({ maxActivePayloadBytes: 8_000_000, completedNotifications: [first, later, legacy] }, 8_000_000)).toThrow(/older oversized|first OCR/);
    expect(() => assertLegacyQueueOrder({ maxActivePayloadBytes: 8_000_000, completedNotifications: [legacy, first, later] }, 8_000_000)).toThrow(/older oversized|first OCR/);
    expect(() => assertLegacyQueueOrder({ maxActivePayloadBytes: 8_000_000, completedNotifications: [later, legacy, first] }, 8_000_000)).toThrow(/first OCR/);
    expect(() => assertLegacyQueueOrder({ maxActivePayloadBytes: 8_000_001, completedNotifications: [first, legacy, later] }, 8_000_000)).toThrow(/older oversized/);
    expect(() => assertLegacyQueueOrder({ maxActivePayloadBytes: 8_000_000, completedNotifications: [first, legacy] }, 8_000_000)).toThrow(/older oversized|first OCR/);
  });
});
