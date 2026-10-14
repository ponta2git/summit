import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

type FairnessScenario = "mixed" | "stream" | "legacyqueue";

/** Synthetic send barriers make arrival order repeatable without real Discord traffic. */
export const runFairnessScenario = async (options: {
  readonly scenario: FairnessScenario;
  readonly rounds: number;
  readonly seedLegacy: () => Promise<number>;
  readonly control: (path: string) => Promise<unknown>;
  readonly post: (value: unknown, kind: "analysis" | "ocr") => Promise<void>;
  readonly analysis: () => unknown;
  readonly ocr: () => unknown;
}): Promise<{
  expectedNotifications: number;
  barriers: { kind: "delivery"; milliseconds: number }[];
  syntheticSendDelayMs: number;
  legacyJsonbBytes?: number;
  analysisPartsAtArrivalEnd?: number;
}> => {
  const { scenario, rounds, seedLegacy, control, post, analysis, ocr } = options;
  const barriers: { kind: "delivery"; milliseconds: number }[] = [];
  if (scenario === "legacyqueue") {
    await control("/hold-delivery");
    const started = performance.now();
    await post(ocr(), "ocr"); await control("/wait/sends/1");
    // The first small delivery is active before the large older row is admitted.
    const legacyJsonbBytes = await seedLegacy();
    await post(ocr(), "ocr");
    await control("/release-delivery"); barriers.push({ kind: "delivery", milliseconds: performance.now() - started });
    await control("/wait/delivered/3");
    return { expectedNotifications: 3, barriers, syntheticSendDelayMs: 0, legacyJsonbBytes };
  }
  const syntheticSendDelayMs = scenario === "stream" ? 5 : 0;
  await control(`/send-delay/${syntheticSendDelayMs}`);
  let expectedNotifications = 0;
  for (let round = 0; round < (scenario === "mixed" ? rounds : 1); round++) {
    await control("/hold-delivery"); const started = performance.now();
    await Promise.all([post(analysis(), "analysis"), post(analysis(), "analysis")]);
    await control("/wait/sends/2");
    await post(ocr(), "ocr");
    await control("/release-delivery"); barriers.push({ kind: "delivery", milliseconds: performance.now() - started });
    expectedNotifications += 3;
    if (scenario === "stream") {
      for (let arrival = 1; arrival < rounds * 2; arrival++) {
        await delay(25);
        await post(ocr(), "ocr"); expectedNotifications++;
      }
      const progress = z.object({ sentPartsByKind: z.object({ analysis_completed: z.number().int().nonnegative() }) })
        .parse(await control("/stats"));
      // why: 特に rounds=1 は観測窓が短い。進行量を保存し、DB latency に依存する閾値で合否を決めない。
      // 完了・試行回数は、到着終了後の persistence contract で別に検証する。
      await control(`/wait/delivered/${expectedNotifications}`);
      return { expectedNotifications, barriers, syntheticSendDelayMs,
        analysisPartsAtArrivalEnd: progress.sentPartsByKind.analysis_completed };
    }
    await control(`/wait/delivered/${expectedNotifications}`);
  }
  return { expectedNotifications, barriers, syntheticSendDelayMs };
};

/** Verify the exclusive legacy drain barrier using completion order, on old and new images alike. */
export const assertLegacyQueueOrder = (rawProbe: unknown, maximumPayloadBytes: number): void => {
  const { completedNotifications, maxActivePayloadBytes } = z.object({ maxActivePayloadBytes: z.number().int().positive(), completedNotifications: z.array(z.object({
    notificationOrdinal: z.number().int().positive(), kind: z.enum(["ocr_completed", "analysis_completed"]), origin: z.enum(["receipt", "seeded_claim"])
  })) }).parse(rawProbe);
  assert.ok(maxActivePayloadBytes <= maximumPayloadBytes, "The older oversized notification must retain its payload alone");
  assert.equal(completedNotifications[0]?.notificationOrdinal, 1, "The first OCR must finish before the legacy notification");
  assert.deepEqual(completedNotifications.map(({ kind, origin }) => ({ kind, origin })), [
    { kind: "ocr_completed", origin: "receipt" },
    { kind: "analysis_completed", origin: "seeded_claim" },
    { kind: "ocr_completed", origin: "receipt" }
  ], "The older oversized notification must drain exclusively before the later OCR");
};
