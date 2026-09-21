import { beforeEach, describe, expect, it } from "vitest";
import { normalizeNotificationJson } from "../../src/db/repositories/notifications.hash.ts";
import { notificationNow } from "../contracts/resultNotifications.ts";
import { analysisNotification } from "../features/result-notifications/fixtures.ts";
import { createResultNotificationHarness } from "./_resultNotifications.ts";
import { isIntegration } from "./_support.ts";

(isIntegration ? describe : describe.skip)("retained OCR v1 notification history", () => {
  let h: Awaited<ReturnType<typeof createResultNotificationHarness>>;
  beforeEach(async () => { h = await createResultNotificationHarness(); });

  it("preserves retired identities but refuses receipt, inspection retry, retry command and dispatch", async () => {
    // Fixture models pre-cutover persisted history; current receipt never accepts this version.
    const legacy = {
      notificationId: "result:ocr_completed:old-image-job", kind: "ocr_completed", schemaVersion: 1,
      sourceJobId: "old-image-job", occurredAt: notificationNow.toISOString(), settingsGeneration: "0",
      data: { matchDraftId: "draft-1", ocrDraftId: "old-ocr", imageId: "old-image", screenType: "total_assets",
        outcome: "succeeded", summary: "読み取りが完了しました。",
        context: { gameTitleName: null, heldDateIso: null, matchNoInEvent: null } }
    };
    const normalized = await normalizeNotificationJson(h.db, JSON.stringify(legacy));
    await h.client`INSERT INTO discord_notifications (id, family, kind, dedupe_key, schema_version, payload, payload_hash, status, terminal_at)
      VALUES (${legacy.notificationId}, 'result', 'ocr_completed', ${legacy.notificationId}, 1, ${normalized.text}::jsonb, ${normalized.hash}, 'FAILED', ${notificationNow.toISOString()}::timestamptz)`;
    await h.client`INSERT INTO discord_notification_results (notification_id, kind, source_job_id, occurred_at, settings_generation)
      VALUES (${legacy.notificationId}, 'ocr_completed', ${legacy.sourceJobId}, ${notificationNow.toISOString()}::timestamptz, 0)`;
    await h.client`INSERT INTO discord_notification_targets (notification_id, target_kind, target_id)
      VALUES (${legacy.notificationId}, 'match_draft', 'draft-1')`;
    const [before] = await h.client`SELECT payload, payload_hash, schema_version FROM discord_notifications WHERE id = ${legacy.notificationId}`;
    expect(await h.port.inspect(legacy.notificationId)).toMatchObject({ status: "FAILED", retryable: false });
    expect(await h.port.retry(legacy.notificationId, notificationNow)).toBe(false);
    await expect(h.port.receive(JSON.stringify(legacy), notificationNow))
      .rejects.toMatchObject({ code: "unsupported_version" });
    await h.client`UPDATE discord_notifications SET status = 'PENDING', terminal_at = NULL WHERE id = ${legacy.notificationId}`;
    expect(await h.port.getNextDispatchAt()).toBeNull();
    expect(await h.port.claim({ limit: 3, now: notificationNow, claimDurationMs: 1_000 })).toStrictEqual([]);
    const analysis = analysisNotification();
    await h.port.receive(JSON.stringify(analysis), notificationNow);
    expect(await h.port.getNextDispatchAt()).toEqual(notificationNow);
    expect((await h.port.claim({ limit: 3, now: notificationNow, claimDurationMs: 1_000 })).map(value => value.id)).toStrictEqual([analysis.notificationId]);
    const [after] = await h.client`SELECT payload, payload_hash, schema_version FROM discord_notifications WHERE id = ${legacy.notificationId}`;
    expect({ ...after }).toStrictEqual({ ...before });
  });
});
