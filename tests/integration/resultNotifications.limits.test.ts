import { beforeEach, describe, expect, it } from "vitest";
import { normalizeNotificationJson } from "../../src/db/repositories/notifications.hash.ts";
import { makeResultNotificationsPort } from "../../src/db/repositories/resultNotifications.ts";
import { NotificationInputError } from "../../src/domain/resultNotificationPayload.ts";
import { RESULT_NOTIFICATION_MAX_BODY_BYTES, RESULT_NOTIFICATION_MAX_JSONB_BYTES,
  RESULT_NOTIFICATION_MAX_OCR_JSONB_BYTES } from "../../src/notifications/config.ts";
import { analysisNotification } from "../features/result-notifications/fixtures.ts";
import { notificationNow as now } from "../contracts/resultNotifications.ts";
import { createResultNotificationHarness } from "./_resultNotifications.ts";
import { isIntegration } from "./_support.ts";

(isIntegration ? describe : describe.skip)("new receipt limits and retained identities", () => {
  let h: Awaited<ReturnType<typeof createResultNotificationHarness>>;
  beforeEach(async () => { h = await createResultNotificationHarness(); });

  const canonicalBoundaryPayload = async (offset: number): Promise<string> => {
    const base = analysisNotification();
    const blank = { ...base, data: { ...base.data, currentAnalysis: { ...base.data.currentAnalysis, algorithmVersion: "" } } };
    const baseline = await normalizeNotificationJson(h.db, JSON.stringify(blank));
    // A free-form metadata field isolates the byte bound from display-name and
    // memo limits. These are valid wire snapshots, not representative job names.
    const payload = { ...blank, data: { ...blank.data, currentAnalysis: {
      ...blank.data.currentAnalysis, algorithmVersion: "x".repeat(256 * 1024 + offset - baseline.bytes)
    } } };
    return JSON.stringify(payload);
  };

  it.each([-1, 0])("accepts the canonical byte boundary at limit %+i", async offset => {
    const raw = await canonicalBoundaryPayload(offset);
    expect(Buffer.byteLength(raw)).toBeLessThan(RESULT_NOTIFICATION_MAX_BODY_BYTES);
    expect((await normalizeNotificationJson(h.db, raw)).bytes).toBe(256 * 1024 + offset);
    expect(await h.port.receive(raw, now)).toMatchObject({ disposition: "accepted", status: "PENDING" });
    expect(await h.port.receive(raw, now)).toMatchObject({ disposition: "duplicate" });
    expect(await h.countReceipts()).toBe(1);
  });

  it("rejects one canonical byte over the limit without persisting a receipt", async () => {
    const raw = await canonicalBoundaryPayload(1);
    expect(Buffer.byteLength(raw)).toBeLessThan(RESULT_NOTIFICATION_MAX_BODY_BYTES);
    expect((await normalizeNotificationJson(h.db, raw)).bytes).toBe(256 * 1024 + 1);
    await expect(h.port.receive(raw, now)).rejects.toMatchObject({ code: "payload_too_large" });
    expect(await h.countReceipts()).toBe(0);
  });

  it("rejects canonical numeric expansion before returning the oversized text to Node", async () => {
    const base = analysisNotification();
    const raw = JSON.stringify({ ...base, data: { ...base.data, metadata: "numeric-expansion" } })
      .replace('"numeric-expansion"', "[1e100000,1e100000,1e100000]");
    expect(Buffer.byteLength(raw)).toBeLessThan(4_096);
    await expect(normalizeNotificationJson(h.db, raw, RESULT_NOTIFICATION_MAX_JSONB_BYTES))
      .rejects.toMatchObject({ code: "payload_too_large" });
    await expect(h.port.receive(raw, now)).rejects.toMatchObject({ code: "payload_too_large" });
    expect(await h.countReceipts()).toBe(0);
  });

  it("measures the smaller OCR normalization budget in UTF-8 bytes", async () => {
    const budget = RESULT_NOTIFICATION_MAX_OCR_JSONB_BYTES;
    const raw = JSON.stringify({ text: "😀".repeat(4_094) });
    expect((await normalizeNotificationJson(h.db, raw)).bytes).toBeGreaterThan(budget);
    await expect(normalizeNotificationJson(h.db, raw, budget)).rejects.toMatchObject({ code: "payload_too_large" });
    expect(await normalizeNotificationJson(h.db, '{"text":"😀"}', budget)).toMatchObject({ bytes: 16 });
  });

  it("preserves old duplicate and conflict semantics even after payload retention", async () => {
    const base = analysisNotification();
    const payload = { ...base, data: { ...base.data, gameTitleName: "界".repeat(257) } };
    const raw = JSON.stringify(payload);
    await expect(h.port.receive(raw, now)).rejects.toMatchObject({ code: "payload_too_large" });
    await h.seedStoredNotification(payload);
    expect(await h.port.receive(raw, now)).toMatchObject({ disposition: "duplicate" });
    await expect(h.port.receive(JSON.stringify({ ...payload, data: { ...payload.data, gameTitleName: "changed" } }), now))
      .rejects.toMatchObject({ code: "identity_conflict" });
    await h.client`UPDATE discord_notifications SET status = 'DELIVERED', terminal_at = ${now.toISOString()}
      WHERE id = ${payload.notificationId}`;
    const afterRetention = new Date(now.getTime() + 31 * 24 * 60 * 60 * 1000);
    expect(await h.port.prune(afterRetention)).toBe(1);
    expect(await h.port.inspect(payload.notificationId)).toMatchObject({ purgedAt: afterRetention });
    expect(await h.port.receive(raw, afterRetention)).toMatchObject({ disposition: "duplicate", status: "DELIVERED" });
  });

  it("does not commit a receipt that fails the injected rendering budget", async () => {
    const base = analysisNotification();
    const port = makeResultNotificationsPort(h.db, () => { throw new NotificationInputError("payload_too_large"); });
    await expect(port.receive(JSON.stringify(base), now)).rejects.toMatchObject({ code: "payload_too_large" });
    expect(await h.countReceipts()).toBe(0);
    expect(await h.client`SELECT * FROM discord_notification_results`).toHaveLength(0);
    expect(await h.client`SELECT * FROM discord_notification_targets`).toHaveLength(0);
  });
});
