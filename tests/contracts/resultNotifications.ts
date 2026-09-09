import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ResultNotificationsPort } from "../../src/db/ports.resultNotifications.ts";
import { analysisNotification, ocrNotification } from "../features/result-notifications/fixtures.ts";

export const notificationNow = new Date("2026-09-09T12:00:00.000Z");
const at = (ms: number): Date => new Date(notificationNow.getTime() + ms);
const context = { channelId: "channel-1", webOrigin: "https://momo.example.com" };
export const ocrReceiptPayload = () => ({ ...ocrNotification(), settingsGeneration: "0" });
export interface ResultContractHarness {
  readonly port: ResultNotificationsPort;
  deleteMatch(): Promise<void>;
  close(): Promise<void>;
}

export const resultNotificationContract = (
  label: string, create: () => Promise<ResultContractHarness>, enabled = true
): void => {
  (enabled ? describe : describe.skip)(`result notification contract (${label})`, () => {
    let harness: ResultContractHarness;
    let port: ResultNotificationsPort;
    const receive = async () => {
      const payload = ocrReceiptPayload(); await port.receive(JSON.stringify(payload), notificationNow); return payload.notificationId;
    };
    const claim = async (ms = 0) => {
      const [entry] = await port.claim({ limit: 3, now: at(ms), claimDurationMs: 1_000 });
      if (!entry) { throw new Error("Expected a result claim"); }
      return entry;
    };
    const plan = (id: string, token: string, count = 2, ms = 0) => port.plan(id, token, { count, rendererVersion: 1, context, now: at(ms) });
    beforeEach(async () => { harness = await create(); port = harness.port; });
    afterEach(async () => { await harness?.close(); });

    it("deduplicates concurrent identical receipts and rejects identity reuse with different content", async () => {
      const payload = ocrReceiptPayload();
      const outcomes = await Promise.all([port.receive(JSON.stringify(payload), notificationNow), port.receive(JSON.stringify(payload), notificationNow)]);
      expect(outcomes.map(result => result.disposition).sort()).toEqual(["accepted", "duplicate"]);
      const reordered = Object.fromEntries(Object.entries(payload).reverse());
      expect((await port.receive(JSON.stringify(reordered), notificationNow)).disposition).toBe("duplicate");
      await expect(port.receive(JSON.stringify({ ...payload, data: { ...payload.data, summary: "Different" } }), notificationNow))
        .rejects.toMatchObject({ code: "identity_conflict" });
      expect(await port.claim({ limit: 3, now: notificationNow, claimDurationMs: 1_000 })).toHaveLength(1);
    });

    it("checks an existing identity before a new version and never persists malformed new input", async () => {
      const payload = ocrReceiptPayload(); await receive();
      await expect(port.receive(JSON.stringify({ ...payload, schemaVersion: 2 }), notificationNow)).rejects.toMatchObject({ code: "identity_conflict" });
      const newPayload = { ...payload, sourceJobId: "new-job", notificationId: "result:ocr_completed:new-job", schemaVersion: 2 };
      await expect(port.receive(JSON.stringify(newPayload), notificationNow)).rejects.toMatchObject({ code: "unsupported_version" });
      expect(await port.inspect(newPayload.notificationId)).toBeNull();
      await expect(port.receive("{invalid", notificationNow)).rejects.toMatchObject({ code: "invalid_input" });
      await expect(port.receive(JSON.stringify({ ...newPayload, schemaVersion: 1, settingsGeneration: "invalid" }), notificationNow))
        .rejects.toMatchObject({ code: "invalid_input" });
    });

    it("OFF/ON increments generations only for actual changes and permanently cancels old receipts", async () => {
      const id = await receive();
      expect(await port.setSetting("ocr_completed", true, notificationNow)).toMatchObject({ generation: "0" });
      expect(await port.setSetting("ocr_completed", false, at(1))).toMatchObject({ generation: "1" });
      expect(await port.setSetting("ocr_completed", true, at(2))).toMatchObject({ generation: "2" });
      expect(await port.inspect(id)).toMatchObject({ status: "CANCELLED", cancelReason: "setting_off", retryable: false });
      const payload = { ...ocrReceiptPayload(), sourceJobId: "delayed", notificationId: "result:ocr_completed:delayed" };
      expect(await port.receive(JSON.stringify(payload), at(3))).toMatchObject({ disposition: "cancelled", status: "CANCELLED" });
      expect(await port.inspect(payload.notificationId)).toMatchObject({ cancelReason: "stale_generation" });
      expect(await port.retry(id, at(4))).toBe(false);
      expect(await port.claim({ limit: 3, now: at(5), claimDurationMs: 1_000 })).toEqual([]);
    });

    it("denies begin after OFF even when the notification was claimed", async () => {
      const id = await receive(); const entry = await claim(); await plan(id, entry.claimToken);
      await port.setSetting("ocr_completed", false, at(1));
      expect(await port.begin(id, 0, entry.claimToken, at(2))).toBe(false);
      expect(await port.inspect(id)).toMatchObject({ status: "CANCELLED", parts: [{ status: "CANCELLED" }, { status: "CANCELLED" }] });
    });

    it("cancels the entire B if one listed match disappears before begin", async () => {
      const payload = analysisNotification(); await port.receive(JSON.stringify(payload), notificationNow);
      const entry = await claim(); await plan(entry.id, entry.claimToken, 3);
      await harness.deleteMatch();
      expect(await port.begin(entry.id, 0, entry.claimToken, at(1))).toBe(false);
      expect(await port.inspect(entry.id)).toMatchObject({ status: "CANCELLED", cancelReason: "match_deleted" });
    });

    it("retains sent and started parts while cancelling every unstarted part", async () => {
      const id = await receive(); const entry = await claim(); await plan(id, entry.claimToken, 3);
      expect(await port.begin(id, 1, entry.claimToken, notificationNow)).toBe(false);
      expect(await port.begin(id, 0, entry.claimToken, notificationNow)).toBe(true);
      expect(await port.complete(id, 0, entry.claimToken, "message-0", at(1))).toBe(true);
      expect(await port.begin(id, 1, entry.claimToken, at(2))).toBe(true);
      await port.setSetting("ocr_completed", false, at(3));
      await port.setSetting("ocr_completed", true, at(4));
      expect(await port.complete(id, 1, entry.claimToken, "message-1", at(5))).toBe(true);
      expect(await port.begin(id, 2, entry.claimToken, at(6))).toBe(false);
      expect(await port.inspect(id)).toMatchObject({ status: "CANCELLED", claimExpiresAt: null,
        parts: [{ status: "DELIVERED", deliveredMessageId: "message-0" }, { status: "DELIVERED", deliveredMessageId: "message-1" }, { status: "CANCELLED", deliveredMessageId: null }] });
      expect((await port.receive(JSON.stringify(ocrReceiptPayload()), at(7))).status).toBe("CANCELLED");
    });

    it("fences expired owners and resumes the stable plan after the last delivered part", async () => {
      const id = await receive(); const old = await claim(); await plan(id, old.claimToken);
      await port.begin(id, 0, old.claimToken, notificationNow); await port.complete(id, 0, old.claimToken, "sent-0", at(1));
      await port.begin(id, 1, old.claimToken, at(2));
      const current = await claim(1_001);
      expect(current.claimToken).not.toBe(old.claimToken);
      expect(current.deliveryContext).toEqual(context);
      expect(current.parts).toMatchObject([{ status: "DELIVERED" }, { status: "PENDING" }]);
      expect(await port.complete(id, 1, old.claimToken, "stale", at(1_002))).toBe(false);
      expect(await port.fail(id, old.claimToken, "delivery_uncertain", at(2_000), at(1_002))).toBe(false);
      expect(await port.renew(id, old.claimToken, at(1_002), 1_000)).toBe(false);
      expect(await port.begin(id, 0, current.claimToken, at(1_002))).toBe(false);
      expect(await port.begin(id, 1, current.claimToken, at(1_002))).toBe(true);
      expect(await port.complete(id, 1, current.claimToken, "sent-1", at(1_003))).toBe(true);
      expect(await port.inspect(id)).toMatchObject({ status: "DELIVERED", attemptCount: 2 });
    });

    it("renews ownership without permitting a late renewal after expiry", async () => {
      const id = await receive(); const entry = await claim();
      expect(await port.renew(id, entry.claimToken, at(900), 1_000)).toBe(true);
      expect(await port.claim({ limit: 1, now: at(1_001), claimDurationMs: 1_000 })).toEqual([]);
      expect(await port.renew(id, entry.claimToken, at(1_901), 1_000)).toBe(false);
      expect((await claim(1_902)).attemptCount).toBe(2);
    });

    it("keeps backoff and refuses to change destinations, renderer or part count on retry", async () => {
      const id = await receive(); const entry = await claim(); await plan(id, entry.claimToken);
      await port.begin(id, 0, entry.claimToken, notificationNow); await port.complete(id, 0, entry.claimToken, "sent", at(1));
      await port.begin(id, 1, entry.claimToken, at(2));
      await port.fail(id, entry.claimToken, "delivery_uncertain", at(5_000), at(3));
      expect(await port.getNextDispatchAt()).toEqual(at(5_000));
      expect(await port.claim({ limit: 3, now: at(4_999), claimDurationMs: 1_000 })).toEqual([]);
      const retried = await claim(5_000);
      expect(retried.parts[0]).toMatchObject({ status: "DELIVERED", deliveredMessageId: "sent" });
      await expect(port.plan(id, retried.claimToken, { count: 2, rendererVersion: 1, context: { ...context, channelId: "changed" }, now: at(5_001) }))
        .rejects.toThrow(/Plan conflict|Notification database operation failed/);
      expect(await plan(id, retried.claimToken, 2, 5_002)).toBe(true);
    });

    it("exhausts crash retries, and only an explicit retry starts another finite cycle", async () => {
      const id = await receive();
      for (let attempt = 0; attempt < 10; attempt += 1) { expect((await claim(attempt * 1_001)).attemptCount).toBe(attempt + 1); }
      expect(await port.claim({ limit: 3, now: at(10_010), claimDurationMs: 1_000 })).toEqual([]);
      expect(await port.inspect(id)).toMatchObject({ status: "FAILED", lastError: "attempt_limit", retryable: true });
      expect(await port.retry(id, at(10_011))).toBe(true);
      expect(await port.inspect(id)).toMatchObject({ status: "PENDING", retryCycle: 1, attemptCount: 0 });
      expect((await port.receive(JSON.stringify(ocrReceiptPayload()), at(10_012))).disposition).toBe("duplicate");
      expect(await port.retry(id, at(10_013))).toBe(false);
    });

    it("retains delivered detail for seven days, then retains its identity forever", async () => {
      const id = await receive(); const entry = await claim(); await plan(id, entry.claimToken, 1);
      await port.begin(id, 0, entry.claimToken, notificationNow); await port.complete(id, 0, entry.claimToken, "sent", notificationNow);
      const week = 7 * 86_400_000;
      expect(await port.prune(at(week - 1))).toBe(0); expect(await port.prune(at(week))).toBe(1);
      expect(await port.inspect(id)).toMatchObject({ status: "DELIVERED", purgedAt: at(week), parts: [], retryable: false });
      expect((await port.receive(JSON.stringify(ocrReceiptPayload()), at(week + 1))).disposition).toBe("duplicate");
      expect(await port.retry(id, at(week + 1))).toBe(false);
      expect(await port.getNextDispatchAt()).toBeNull();
    });

    it("retains failure detail for thirty days and never prunes active work", async () => {
      const id = await receive(); const entry = await claim();
      await port.fail(id, entry.claimToken, "invalid_payload", null, notificationNow);
      const payload = { ...ocrReceiptPayload(), notificationId: "result:ocr_completed:active", sourceJobId: "active" };
      await port.receive(JSON.stringify(payload), notificationNow);
      const month = 30 * 86_400_000;
      expect(await port.prune(at(month - 1))).toBe(0); expect(await port.prune(at(month))).toBe(1);
      expect(await port.inspect(payload.notificationId)).toMatchObject({ status: "PENDING", purgedAt: null });
      expect(await port.retry(id, at(month + 1))).toBe(false);
      await expect(port.receive(JSON.stringify({ ...ocrReceiptPayload(), data: { ...ocrReceiptPayload().data, summary: "changed" } }), at(month + 1)))
        .rejects.toMatchObject({ code: "identity_conflict" });
    });

    it("does not reconstruct unreceived successes and omits locally active IDs from discovery", async () => {
      expect(await port.getNextDispatchAt()).toBeNull();
      expect(await port.claim({ limit: 3, now: notificationNow, claimDurationMs: 1_000 })).toEqual([]);
      const id = await receive();
      expect(await port.getNextDispatchAt([id])).toBeNull();
      expect(await port.claim({ limit: 3, now: notificationNow, claimDurationMs: 1_000, excludeIds: [id] })).toEqual([]);
    });
  });
};
