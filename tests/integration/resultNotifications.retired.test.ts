import { beforeEach, describe, expect, it } from "vitest";
import { normalizeNotificationJson } from "../../src/db/repositories/notifications.hash.ts";
import { notificationNow } from "../contracts/resultNotifications.ts";
import { analysisNotification } from "../features/result-notifications/fixtures.ts";
import { createResultNotificationHarness } from "./_resultNotifications.ts";
import { isIntegration } from "./_support.ts";

(isIntegration ? describe : describe.skip)("retained OCR v1 notification history", () => {
  let harness: Awaited<ReturnType<typeof createResultNotificationHarness>>;
  beforeEach(async () => { harness = await createResultNotificationHarness(); });

  it("preserves retired identities but refuses receipt, inspection retry, retry command and dispatch", async () => {
    // Fixture models pre-cutover persisted history; current receipt never accepts this version.
    const legacy = {
      notificationId: "result:ocr_completed:old-image-job", kind: "ocr_completed", schemaVersion: 1,
      sourceJobId: "old-image-job", occurredAt: notificationNow.toISOString(), settingsGeneration: "0",
      data: { matchDraftId: "draft-1", ocrDraftId: "old-ocr", imageId: "old-image", screenType: "total_assets",
        outcome: "succeeded", summary: "読み取りが完了しました。",
        context: { gameTitleName: null, heldDateIso: null, matchNoInEvent: null } }
    };
    const normalized = await normalizeNotificationJson(harness.db, JSON.stringify(legacy));
    await harness.client`INSERT INTO discord_notifications (id, family, kind, dedupe_key, schema_version, payload, payload_hash, status, terminal_at)
      VALUES (${legacy.notificationId}, 'result', 'ocr_completed', ${legacy.notificationId}, 1, ${normalized.text}::jsonb, ${normalized.hash}, 'FAILED', ${notificationNow.toISOString()}::timestamptz)`;
    await harness.client`INSERT INTO discord_notification_results (notification_id, kind, source_job_id, occurred_at, settings_generation)
      VALUES (${legacy.notificationId}, 'ocr_completed', ${legacy.sourceJobId}, ${notificationNow.toISOString()}::timestamptz, 0)`;
    await harness.client`INSERT INTO discord_notification_targets (notification_id, target_kind, target_id)
      VALUES (${legacy.notificationId}, 'match_draft', 'draft-1')`;
    const [before] = await harness.client`SELECT payload, payload_hash, schema_version FROM discord_notifications WHERE id = ${legacy.notificationId}`;
    expect(await harness.port.inspect(legacy.notificationId)).toMatchObject({ status: "FAILED", retryable: false });
    expect(await harness.port.retry(legacy.notificationId, notificationNow)).toBe(false);
    await expect(harness.port.receive(JSON.stringify(legacy), notificationNow))
      .rejects.toMatchObject({ code: "unsupported_version" });
    await harness.client`UPDATE discord_notifications SET status = 'PENDING', terminal_at = NULL WHERE id = ${legacy.notificationId}`;
    expect(await harness.port.getNextDispatchAt()).toBeNull();
    expect(await harness.port.claim({ limit: 3, now: notificationNow, claimDurationMs: 1_000 })).toStrictEqual([]);
    const analysis = analysisNotification();
    await harness.port.receive(JSON.stringify(analysis), notificationNow);
    expect(await harness.port.getNextDispatchAt()).toEqual(notificationNow);
    expect((await harness.port.claim({ limit: 3, now: notificationNow, claimDurationMs: 1_000 })).map(value => value.id)).toStrictEqual([analysis.notificationId]);
    const [after] = await harness.client`SELECT payload, payload_hash, schema_version FROM discord_notifications WHERE id = ${legacy.notificationId}`;
    expect({ ...after }).toStrictEqual({ ...before });
  });
});
