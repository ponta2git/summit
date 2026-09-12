import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { matchDrafts, matches } from "../../src/db/schema.ts";
import { notificationTransaction, cancelNotification, lockNotificationFamily } from "../../src/db/repositories/notifications.storage.ts";
import { receiveResultNotification } from "../../src/db/repositories/resultNotifications.receipt.ts";
import { setResultSetting } from "../../src/db/repositories/resultNotifications.state.ts";
import { normalizeNotificationJson } from "../../src/db/repositories/notifications.hash.ts";
import { analysisNotification } from "../features/result-notifications/fixtures.ts";
import { ocrReceiptPayload, notificationNow as now } from "../contracts/resultNotifications.ts";
import { createResultNotificationHarness } from "./_resultNotifications.ts";
import { isIntegration } from "./_support.ts";

const barrier = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};

(isIntegration ? describe : describe.skip)("result receipt transaction boundaries", () => {
  let h: Awaited<ReturnType<typeof createResultNotificationHarness>>;
  beforeEach(async () => { h = await createResultNotificationHarness(); });
  afterEach(async () => { await h?.close(); });

  const waitForBlockedBy = async (pid: number) => {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const [row] = await h.client`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
        WHERE ${pid} = ANY(pg_blocking_pids(pid))) AS blocked`;
      if (row?.["blocked"]) { return; }
      await setImmediate();
    }
    throw new Error("Expected notification transaction did not reach the gate");
  };

  it("rolls back receipt, targets and parts together when its command fails after insertion", async () => {
    const payload = ocrReceiptPayload();
    await expect(notificationTransaction(h.db, "result", async tx => {
      await receiveResultNotification(tx, JSON.stringify(payload), now);
      throw new Error("abort receipt command");
    })).rejects.toThrow("abort receipt command");
    expect(await h.countReceipts()).toBe(0);
    const [counts] = await h.client`SELECT
      (SELECT count(*)::int FROM discord_notification_results) AS results,
      (SELECT count(*)::int FROM discord_notification_targets) AS targets`;
    expect({ ...counts }).toEqual({ results: 0, targets: 0 });
  });

  it("serializes OFF after receipt commit and exposes no receipt before commit", async () => {
    const inserted = barrier(); const commit = barrier(); let pid = 0;
    const payload = ocrReceiptPayload();
    const receiving = notificationTransaction(h.db, "result", async tx => {
      pid = Number((await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`))[0]?.pid);
      const result = await receiveResultNotification(tx, JSON.stringify(payload), now);
      inserted.release(); await commit.promise; return result;
    });
    await inserted.promise;
    const off = h.port.setSetting("ocr_completed", false, now);
    try { await waitForBlockedBy(pid); expect(await h.countReceipts()).toBe(0); }
    finally { commit.release(); }
    expect((await receiving).disposition).toBe("accepted"); await off;
    expect(await h.port.inspect(payload.notificationId)).toMatchObject({ status: "CANCELLED", cancelReason: "setting_off" });
  });

  it("observes OFF/ON committed ahead of a delayed receipt and rejects its old generation", async () => {
    const changed = barrier(); const commit = barrier(); let pid = 0;
    const settings = notificationTransaction(h.db, "result", async tx => {
      pid = Number((await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`))[0]?.pid);
      await setResultSetting(tx, "ocr_completed", false, now); await setResultSetting(tx, "ocr_completed", true, now);
      changed.release(); await commit.promise;
    });
    await changed.promise;
    const receipt = h.port.receive(JSON.stringify(ocrReceiptPayload()), now);
    try { await waitForBlockedBy(pid); } finally { commit.release(); }
    await settings;
    expect(await receipt).toMatchObject({ disposition: "cancelled", status: "CANCELLED" });
    expect(await h.port.inspect(ocrReceiptPayload().notificationId)).toMatchObject({ cancelReason: "stale_generation" });
  });

  it("does not lock source rows during receipt; the source command then cancels atomically at its tail", async () => {
    const changed = barrier(); const finish = barrier();
    const payload = ocrReceiptPayload();
    const source = h.db.transaction(async tx => {
      await tx.update(matchDrafts).set({ status: "cancelled" }).where(eq(matchDrafts.id, payload.data.matchDraftId));
      changed.release(); await finish.promise;
      await lockNotificationFamily(tx, "result");
      await cancelNotification(tx, payload.notificationId, "draft_unavailable", now);
    });
    await changed.promise;
    try {
      expect((await h.port.receive(JSON.stringify(payload), now)).disposition).toBe("accepted");
      expect(await h.port.inspect(payload.notificationId)).toMatchObject({ status: "PENDING" });
    } finally { finish.release(); }
    await source;
    expect(await h.port.inspect(payload.notificationId)).toMatchObject({ status: "CANCELLED", cancelReason: "draft_unavailable" });
  });

  it("retains frozen B detail when live match notes and names change", async () => {
    const payload = analysisNotification();
    await h.port.receive(JSON.stringify(payload), now);
    await h.db.update(matches).set({ noteBody: "Edited after receipt", noteVersion: 1n,
      noteUpdatedAt: now, noteUpdatedByAccountId: "result-account" }).where(eq(matches.id, "match-1"));
    const [entry] = await h.port.claim({ limit: 1, now, claimDurationMs: 1_000 });
    expect(entry?.payload).toEqual(payload);
  });

  it("cancels a backlog atomically across batches while preserving delivered and started parts", async () => {
    const payload = ocrReceiptPayload();
    await notificationTransaction(h.db, "result", async tx => {
      for (let index = 0; index < 300; index += 1) {
        const sourceJobId = `backlog-${String(index).padStart(3, "0")}`;
        await receiveResultNotification(tx, JSON.stringify({ ...payload, sourceJobId,
          notificationId: `result:ocr_completed:${sourceJobId}` }), now);
      }
    });
    const [sending, unstarted, failed] = await h.port.claim({ limit: 3, now, claimDurationMs: 30_000 });
    if (!sending || !unstarted || !failed) { throw new Error("Expected backlog claims"); }
    for (const entry of [sending, unstarted]) {
      await h.port.plan(entry.id, entry.claimToken, { count: 2, rendererVersion: 1,
        context: { webOrigin: "https://example.test", channelId: "channel" }, now });
    }
    await h.port.begin(sending.id, 0, sending.claimToken, now);
    await h.port.complete(sending.id, 0, sending.claimToken, "first-message", now);
    await h.port.begin(sending.id, 1, sending.claimToken, now);
    await h.port.fail(failed.id, failed.claimToken, "delivery_failed", null, now);
    const analysis = analysisNotification();
    await h.port.receive(JSON.stringify(analysis), now);

    await expect(notificationTransaction(h.db, "result", async tx => {
      await setResultSetting(tx, "ocr_completed", false, now);
      throw new Error("abort OFF after all batches");
    })).rejects.toThrow("abort OFF");
    expect(await h.port.getSetting("ocr_completed")).toMatchObject({ enabled: true, generation: "0" });
    expect((await h.client`SELECT id FROM discord_notifications WHERE status = 'CANCELLED'`).length).toBe(0);

    await h.port.setSetting("ocr_completed", false, now);
    const [counts] = await h.client`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled,
      count(*) FILTER (WHERE claim_token IS NOT NULL)::int AS claimed
      FROM discord_notifications WHERE kind = 'ocr_completed'`;
    expect({ ...counts }).toEqual({ total: 300, cancelled: 300, claimed: 1 });
    expect(await h.port.inspect(sending.id)).toMatchObject({ status: "CANCELLED", parts: [
      { status: "DELIVERED", deliveredMessageId: "first-message" }, { status: "IN_FLIGHT" }
    ] });
    expect(await h.port.inspect(unstarted.id)).toMatchObject({ status: "CANCELLED", parts: [
      { status: "CANCELLED" }, { status: "CANCELLED" }
    ] });
    expect(await h.port.complete(sending.id, 1, sending.claimToken, "started-message", now)).toBe(true);
    expect(await h.port.inspect(sending.id)).toMatchObject({ status: "CANCELLED" });
    expect(await h.port.inspect(analysis.notificationId)).toMatchObject({ status: "PENDING" });
  });

  it("matches hashes produced by the historical SQL contract without losing decimals or escaped text", async () => {
    // Oracle values were checked against migration 0042 in momo-db's backup/restore test.
    const vectors = JSON.parse(readFileSync(new URL("./notification-hash-v1.json", import.meta.url), "utf8")) as { raw: string; hash: string }[];
    for (const vector of vectors) {
      expect((await normalizeNotificationJson(h.db, vector.raw)).hash).toBe(vector.hash);
    }
  });

  it("measures canonical JSON in UTF-8 bytes, including non-BMP characters", async () => {
    const normalized = await normalizeNotificationJson(h.db, '{"text":"日本😀"}');
    expect({ text: normalized.text, bytes: normalized.bytes }).toEqual({ text: '{"text": "日本😀"}', bytes: 22 });
  });
});
