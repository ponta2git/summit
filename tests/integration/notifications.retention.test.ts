import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, isNull, sql } from "drizzle-orm";
import { discordNotifications as notifications, discordNotificationAttendance as attendance, discordNotificationParts as parts } from "../../src/db/schema.ts";
import { normalizeNotificationJson } from "../../src/db/repositories/notifications.hash.ts";
import { notificationTransaction } from "../../src/db/repositories/notifications.storage.ts";
import { purgeNotifications } from "../../src/db/repositories/notifications.retention.ts";
import { createOutboxContractHarness } from "./_outboxContract.ts";
import { isIntegration } from "./_support.ts";

(isIntegration ? describe : describe.skip)("notification retention batches", () => {
  const h = createOutboxContractHarness();
  beforeAll(async () => { await h.initialize(); await h.reset(); });
  afterAll(async () => { await h.close(); });

  it("purges beyond one batch atomically, retaining every identity and recent detail", async () => {
    const now = new Date("2026-09-09T12:00:00.000Z");
    const expired = new Date("2026-07-01T00:00:00.000Z");
    const hash = (await normalizeNotificationJson(h.db, JSON.stringify(h.basePayload))).hash;
    const rows = Array.from({ length: 1_003 }, (_, i) => ({
      id: `retention-${i}`, family: "attendance", kind: "send_message", dedupeKey: `retention-${i}`,
      payload: h.basePayload, payloadHash: hash, status: "DELIVERED",
      attemptCount: 1, terminalAt: i === 1_002 ? now : expired, deliveredAt: i === 1_002 ? now : expired,
      partCount: 1, rendererVersion: 1
    }));
    // Fixture completed deliveries directly so the test isolates large retention commands.
    await h.db.insert(notifications).values(rows);
    await h.db.insert(attendance).values(rows.map((row, ordinal) => ({
      notificationId: row.id, sessionId: h.baseSession.id, aggregateRevision: 0, ordinal
    })));
    await h.db.insert(parts).values(rows.map(row => ({
      notificationId: row.id, partNo: 0, status: "DELIVERED", attemptCount: 1,
      sendStartedAt: row.terminalAt, deliveredAt: row.deliveredAt, deliveredMessageId: `message-${row.id}`
    })));
    const prune = (tx: Parameters<typeof purgeNotifications>[0]) =>
      purgeNotifications(tx, "attendance", now, { deliveredOlderThan: now, failedOlderThan: now });
    await expect(notificationTransaction(h.db, "attendance", async tx => {
      await prune(tx); throw new Error("abort retention command");
    })).rejects.toThrow("abort retention command");
    expect(await h.db.select({ id: notifications.id }).from(notifications).where(isNull(notifications.purgedAt))).toHaveLength(1_003);
    expect(await h.db.select({ id: parts.notificationId }).from(parts)).toHaveLength(1_003);

    expect(await notificationTransaction(h.db, "attendance", prune))
      .toEqual({ deliveredPruned: 1_002, failedPruned: 0, cancelledPruned: 0 });
    const [counts] = await h.db.execute<{ total: number; purged: number }>(sql`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE purged_at IS NOT NULL AND payload IS NULL AND payload_hash = ${hash})::int AS purged
      FROM discord_notifications`);
    expect(counts).toEqual({ total: 1_003, purged: 1_002 });
    expect(await h.db.select({ id: parts.notificationId }).from(parts)).toEqual([{ id: "retention-1002" }]);
    expect(await h.db.select({ payload: notifications.payload }).from(notifications).where(eq(notifications.id, "retention-1002")))
      .toEqual([{ payload: h.basePayload }]);
  });
});
