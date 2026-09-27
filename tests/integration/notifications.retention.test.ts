import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isNull, sql } from "drizzle-orm";
import { discordNotifications as notifications, discordNotificationAttendance as attendance, discordNotificationParts as parts } from "../../src/db/schema.ts";
import { normalizeNotificationJson } from "../../src/db/repositories/notifications.hash.ts";
import { notificationTransaction } from "../../src/db/repositories/notifications.storage.ts";
import { pruneNotificationBatches, purgeNotifications } from "../../src/db/repositories/notifications.retention.ts";
import { NOTIFICATION_MAINTENANCE_BATCH_SIZE, NOTIFICATION_RETENTION_MAX_BATCHES } from "../../src/notifications/config.ts";
import { createOutboxContractHarness } from "./_outboxContract.ts";
import { isIntegration } from "./_support.ts";

(isIntegration ? describe : describe.skip)("notification retention batches", () => {
  const h = createOutboxContractHarness();
  const now = new Date("2026-09-09T12:00:00.000Z");
  const expired = new Date("2026-07-01T00:00:00.000Z");
  const cutoffs = { deliveredOlderThan: now, failedOlderThan: now };
  beforeAll(async () => { await h.initialize(); });
  beforeEach(async () => { await h.reset(); });
  afterEach(async () => {
    await h.db.execute(sql`DROP TRIGGER IF EXISTS retention_test_trigger ON discord_notifications`);
    await h.db.execute(sql`DROP FUNCTION IF EXISTS retention_test_trigger()`);
    await h.db.execute(sql`DROP TABLE IF EXISTS retention_audit`);
  });
  afterAll(async () => { await h.close(); });

  const seed = async (count: number): Promise<string> => {
    const hash = (await normalizeNotificationJson(h.db, JSON.stringify(h.basePayload))).hash;
    for (let start = 0; start < count; start += 256) {
      const rows = Array.from({ length: Math.min(256, count - start) }, (_, offset) => ({
        id: `retention-${String(start + offset).padStart(6, "0")}`, family: "attendance", kind: "send_message",
        dedupeKey: `retention-${start + offset}`, payload: h.basePayload, payloadHash: hash, status: "DELIVERED",
        attemptCount: 1, terminalAt: expired, deliveredAt: expired, partCount: 1, rendererVersion: 1
      }));
      await h.db.insert(notifications).values(rows);
      await h.db.insert(attendance).values(rows.map((row, offset) => ({
        notificationId: row.id, sessionId: h.baseSession.id, aggregateRevision: 0, ordinal: start + offset
      })));
      await h.db.insert(parts).values(rows.map(row => ({
        notificationId: row.id, partNo: 0, status: "DELIVERED", attemptCount: 1,
        sendStartedAt: expired, deliveredAt: expired, deliveredMessageId: `message-${row.id}`
      })));
    }
    return hash;
  };

  it("rolls back a failed batch's payload and part deletion together, retaining every identity", async () => {
    const count = NOTIFICATION_MAINTENANCE_BATCH_SIZE + 5;
    const hash = await seed(count);
    await expect(notificationTransaction(h.db, "attendance", async tx => {
      await purgeNotifications(tx, "attendance", now, cutoffs);
      throw new Error("abort retention batch");
    })).rejects.toThrow("abort retention batch");
    expect(await h.db.select({ id: notifications.id }).from(notifications).where(isNull(notifications.purgedAt))).toHaveLength(count);
    expect(await h.db.select({ id: parts.notificationId }).from(parts)).toHaveLength(count);

    expect(await notificationTransaction(h.db, "attendance", tx => purgeNotifications(tx, "attendance", now, cutoffs)))
      .toEqual({ deliveredPruned: NOTIFICATION_MAINTENANCE_BATCH_SIZE, failedPruned: 0, cancelledPruned: 0 });
    const [counts] = await h.db.execute<{ total: number; purged: number }>(sql`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE purged_at IS NOT NULL AND payload IS NULL AND payload_hash = ${hash})::int AS purged
      FROM discord_notifications`);
    expect(counts).toEqual({ total: count, purged: NOTIFICATION_MAINTENANCE_BATCH_SIZE });
    expect(await h.db.select({ id: parts.notificationId }).from(parts)).toHaveLength(5);
  });

  it("commits each bounded batch and leaves overflow for the next finite retention pass", async () => {
    const budget = NOTIFICATION_MAINTENANCE_BATCH_SIZE * NOTIFICATION_RETENTION_MAX_BATCHES;
    await seed(budget + 3);
    await h.db.execute(sql`CREATE TABLE retention_audit (transaction_id bigint NOT NULL)`);
    await h.db.execute(sql`CREATE FUNCTION retention_test_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.purged_at IS NOT NULL AND OLD.purged_at IS NULL THEN
          INSERT INTO retention_audit VALUES (txid_current());
        END IF;
        RETURN NEW;
      END $$`);
    await h.db.execute(sql`CREATE TRIGGER retention_test_trigger AFTER UPDATE ON discord_notifications
      FOR EACH ROW EXECUTE FUNCTION retention_test_trigger()`);
    expect(await pruneNotificationBatches(h.db, "attendance", now, cutoffs))
      .toEqual({ deliveredPruned: budget, failedPruned: 0, cancelledPruned: 0 });
    const transactions = await h.db.execute<{ count: number }>(sql`SELECT count(*)::int AS count
      FROM retention_audit GROUP BY transaction_id`);
    expect(transactions).toHaveLength(NOTIFICATION_RETENTION_MAX_BATCHES);
    expect(transactions.every(row => row.count === NOTIFICATION_MAINTENANCE_BATCH_SIZE)).toBe(true);
    expect(await h.db.select({ id: parts.notificationId }).from(parts)).toHaveLength(3);
    expect(await pruneNotificationBatches(h.db, "attendance", now, cutoffs))
      .toEqual({ deliveredPruned: 3, failedPruned: 0, cancelledPruned: 0 });
    expect(await h.db.select({ id: notifications.id }).from(notifications)).toHaveLength(budget + 3);
    expect(await h.db.select({ id: parts.notificationId }).from(parts)).toEqual([]);
  });

  it("keeps committed batches when a later batch fails, then resumes the untouched detail", async () => {
    const count = NOTIFICATION_MAINTENANCE_BATCH_SIZE + 5;
    await seed(count);
    await h.db.execute(sql`CREATE FUNCTION retention_test_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id = 'retention-000256' AND NEW.purged_at IS NOT NULL THEN RAISE EXCEPTION 'controlled retention failure'; END IF;
        RETURN NEW;
      END $$`);
    await h.db.execute(sql`CREATE TRIGGER retention_test_trigger BEFORE UPDATE ON discord_notifications
      FOR EACH ROW EXECUTE FUNCTION retention_test_trigger()`);
    await expect(pruneNotificationBatches(h.db, "attendance", now, cutoffs)).rejects.toMatchObject({ cause: { code: "P0001" } });
    const [remaining] = await h.db.execute<{ intact: number; purged: number }>(sql`SELECT
      count(*) FILTER (WHERE purged_at IS NULL AND payload IS NOT NULL
        AND EXISTS(SELECT 1 FROM discord_notification_parts p WHERE p.notification_id = discord_notifications.id))::int AS intact,
      count(*) FILTER (WHERE purged_at IS NOT NULL AND payload IS NULL
        AND NOT EXISTS(SELECT 1 FROM discord_notification_parts p WHERE p.notification_id = discord_notifications.id))::int AS purged
      FROM discord_notifications`);
    expect(remaining).toEqual({ intact: 5, purged: NOTIFICATION_MAINTENANCE_BATCH_SIZE });
    await h.db.execute(sql`DROP TRIGGER retention_test_trigger ON discord_notifications`);
    expect(await pruneNotificationBatches(h.db, "attendance", now, cutoffs))
      .toEqual({ deliveredPruned: 5, failedPruned: 0, cancelledPruned: 0 });
  });
});
