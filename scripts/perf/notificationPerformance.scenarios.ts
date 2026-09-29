import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import type postgres from "postgres";
import { RESULT_NOTIFICATION_MAX_BODY_BYTES, RESULT_NOTIFICATION_MAX_JSONB_BYTES } from "../../src/notifications/config.ts";
import { ocrNotification } from "../../tests/features/result-notifications/fixtures.ts";
import { capacityAnalysis, capacityNamePoints, canonicalCapacityBytes } from "../verify/notificationCapacity.fixtures.ts";
import { capacityMetrics } from "../verify/notificationCapacity.contract.ts";
import type { CapacitySession } from "../verify/notificationCapacity.scenarios.ts";
import { performanceControl, performancePost, type PerformanceHttpSample } from "./notificationPerformance.http.ts";
import { performanceStage, type PerformanceScenario } from "./notificationPerformance.contract.ts";
import { capacityPartAnalysis } from "./notificationPerformance.parts.ts";

const ocr = (index: number) => ({
  ...ocrNotification(`00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`), settingsGeneration: "0"
});
const databaseRows = async (client: postgres.Sql) => {
  const [row] = await client<{ notifications: number; delivered: number; failed: number; plannedParts: number; completedParts: number }[]>`
    SELECT count(*)::int AS notifications, count(*) FILTER (WHERE status = 'DELIVERED')::int AS delivered,
      count(*) FILTER (WHERE status = 'FAILED')::int AS failed, coalesce(sum(part_count), 0)::int AS "plannedParts",
      (SELECT count(*)::int FROM discord_notification_parts WHERE status = 'DELIVERED') AS "completedParts"
    FROM discord_notifications WHERE family = 'result'`;
  assert.ok(row); return row;
};

export const runPerformanceScenario = async (session: CapacitySession, client: postgres.Sql, options: {
  readonly scenario: PerformanceScenario; readonly rounds: number; readonly legacyBytes?: number;
}) => {
  const { scenario, rounds } = options;
  const points = await capacityNamePoints(client, RESULT_NOTIFICATION_MAX_JSONB_BYTES);
  const fixture = (index: number, mode: "normal" | "unicode" | "markdown" | "parts") => {
    const sourceId = `perf-${mode}-${index.toString().padStart(4, "0")}`;
    return mode === "parts" ? capacityPartAnalysis(sourceId)
      : capacityAnalysis(sourceId, mode, mode === "unicode" ? points : 256);
  };
  const modes = scenario === "normal" ? ["normal"] as const : scenario === "markdown" ? ["markdown"] as const
    : scenario === "parts" ? ["parts"] as const
    : scenario === "soak" ? ["unicode", "markdown"] as const : scenario === "legacy" ? [] : ["unicode"] as const;
  const fixtureBytes: Record<string, { jsonBytes: number; jsonbBytes: number; nameCodePoints?: number }> = {};
  for (const mode of modes) {
    const value = fixture(0, mode);
    fixtureBytes[mode] = { jsonBytes: Buffer.byteLength(JSON.stringify(value)),
      jsonbBytes: await canonicalCapacityBytes(client, value), nameCodePoints: [...value.data.gameTitleName].length };
  }
  if (scenario === "normal") {
    fixtureBytes["ocr"] = { jsonBytes: Buffer.byteLength(JSON.stringify(ocr(1))), jsonbBytes: await canonicalCapacityBytes(client, ocr(1)) };
  }
  const conflictBase = JSON.stringify(capacityAnalysis("performance-warmup", "normal"));
  const conflictRaw = `${conflictBase.slice(0, -1)},"capacityNumericMetadata":[${Array.from({ length: 80 }, () => "1e100000").join(",")}]}`;
  if (scenario === "overlap") {
    const [size] = await client<{ bytes: number }[]>`SELECT octet_length(${conflictRaw}::jsonb::text) AS bytes`;
    assert.ok(size && size.bytes > 7.5 * 1024 * 1024 && size.bytes < 8 * 1024 * 1024);
    fixtureBytes["conflict"] = { jsonBytes: Buffer.byteLength(conflictRaw), jsonbBytes: size.bytes };
  }
  const control = (path: string) => performanceControl(session, path);
  const httpSamples: PerformanceHttpSample[] = [];
  const post = async (value: unknown, kind: "analysis" | "ocr", wireBytes?: number, barrierHeld = false): Promise<void> => {
    const sample = await performancePost(session, JSON.stringify(value), kind, { ...(wireBytes === undefined ? {} : { wireBytes }), barrierHeld });
    assert.equal(sample.status, 202); httpSamples.push(sample);
  };
  if (scenario !== "legacy") {
    await performanceStage("warmup", async () => {
      const warmup = capacityAnalysis("performance-warmup", "normal");
      assert.equal((await performancePost(session, JSON.stringify(warmup), "analysis")).status, 202);
      assert.equal((await performancePost(session, JSON.stringify(ocr(0)), "ocr")).status, 202);
      await control("/wait/delivered/2"); await control("/gc");
    });
  }
  const rowsBefore = await databaseRows(client);
  await control("/reset");
  const started = performance.now();
  const barriers: { kind: "delivery" | "receipt"; milliseconds: number }[] = [];
  let expectedNotifications = 0;
  let index = 0;
  await performanceStage(`scenario_${scenario}`, async () => {
    if (scenario === "legacy") {
      expectedNotifications = 1;
      await control("/wake"); await control("/wait/delivered/1");
      return;
    }
    if (scenario === "overlap") {
      await control("/hold-delivery");
      const deliveryHold = performance.now();
      await Promise.all([post(fixture(index++, "unicode"), "analysis", RESULT_NOTIFICATION_MAX_BODY_BYTES),
        post(fixture(index++, "unicode"), "analysis", RESULT_NOTIFICATION_MAX_BODY_BYTES)]);
      await control("/wait/sends/2");
      await control("/hold-receipts");
      let receiptHold = performance.now();
      const receipts = Promise.all([post(fixture(index++, "unicode"), "analysis", RESULT_NOTIFICATION_MAX_BODY_BYTES, true),
        post(fixture(index++, "unicode"), "analysis", RESULT_NOTIFICATION_MAX_BODY_BYTES, true)]);
      void receipts.catch(() => undefined);
      await control("/wait/receipts/2");
      const overloaded = await performancePost(session, JSON.stringify(ocr(1)), "overload", { chunked: true, barrierHeld: true });
      assert.equal(overloaded.status, 503); httpSamples.push(overloaded);
      await control("/release-receipts"); barriers.push({ kind: "receipt", milliseconds: performance.now() - receiptHold });
      await receipts;
      await control("/hold-receipts"); receiptHold = performance.now();
      const conflicts = Promise.all(Array.from({ length: 4 }, () => performancePost(session, conflictRaw, "conflict", { barrierHeld: true })));
      void conflicts.catch(() => undefined);
      await control("/wait/receipts/4");
      await control("/release-receipts"); barriers.push({ kind: "receipt", milliseconds: performance.now() - receiptHold });
      const conflictSamples = await conflicts;
      assert.ok(conflictSamples.every(sample => sample.status === 409)); httpSamples.push(...conflictSamples);
      await control("/release-delivery"); barriers.push({ kind: "delivery", milliseconds: performance.now() - deliveryHold });
      expectedNotifications = 4; await control("/wait/delivered/4");
      return;
    }
    for (let round = 0; round < rounds; round++) {
      const batches = scenario === "soak" ? 5 : 1;
      for (let batch = 0; batch < batches; batch++) {
        if (scenario === "normal") {
          await Promise.all([post(fixture(index++, "normal"), "analysis"), post(ocr(index++), "ocr")]);
        } else {
          const secondMode = scenario === "soak" ? "markdown" : scenario;
          assert.ok(secondMode === "unicode" || secondMode === "markdown" || secondMode === "parts");
          const firstMode = scenario === "soak" ? "unicode" : secondMode;
          await Promise.all([post(fixture(index++, firstMode), "analysis"), post(fixture(index++, secondMode), "analysis")]);
        }
        expectedNotifications += 2;
      }
      await control(`/wait/delivered/${expectedNotifications}`);
      console.log(JSON.stringify({ event: "notification_performance.round", scenario, round: round + 1,
        completedNotifications: expectedNotifications }));
    }
  });
  const elapsedMilliseconds = performance.now() - started;
  const rawProbe = await control("/finish");
  const metrics = await performanceStage("capacity_metrics_schema", async () => capacityMetrics.parse(rawProbe));
  const rowsAfter = await databaseRows(client);
  await performanceStage("persistence_contract", async () => {
  assert.equal(metrics.deliveredNotifications, expectedNotifications);
  assert.equal(rowsAfter.failed, rowsBefore.failed);
  assert.equal(rowsAfter.delivered - rowsBefore.delivered, expectedNotifications);
  assert.equal(rowsAfter.completedParts - rowsBefore.completedParts, metrics.sentParts);
  assert.equal(rowsAfter.plannedParts, rowsAfter.completedParts);
  if (scenario === "legacy") { assert.ok(metrics.sentParts > 8_000 && metrics.sentParts <= 10_000); }
  if (scenario === "overlap") { assert.equal(metrics.maxPendingSends, 2); assert.equal(metrics.maxPendingReceipts, 4); }
  });
  return { rawProbe, httpSamples, host: { elapsedMilliseconds, forcedGcDuringWorkload: false }, workload: {
    fixtureBytes, expectedNotifications, completedParts: metrics.sentParts,
    rounds: ["legacy", "overlap"].includes(scenario) ? 1 : rounds,
    warmupNotifications: scenario === "legacy" ? 0 : 2, barrierControlled: scenario === "overlap", barriers,
    ...(options.legacyBytes === undefined ? {} : { legacyJsonbBytes: options.legacyBytes }), rowsBefore, rowsAfter
  } };
};
