import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { requeueFailedOutboxChains } from "../../src/db/repositories/outbox.recovery.ts";
import { NOTIFICATION_MAINTENANCE_BATCH_SIZE } from "../../src/notifications/config.ts";
import { createIntegrationDb, isIntegration } from "./_support.ts";

(isIntegration ? describe : describe.skip)("startup recovery capacity", () => {
  const { db, client } = createIntegrationDb();
  afterAll(() => client.end({ timeout: 5 }));

  it("recovers chains across Session pages while preserving delivered parts and manual cancellation", async () => {
    const count = NOTIFICATION_MAINTENANCE_BATCH_SIZE + 1;
    await db.execute(sql`INSERT INTO sessions (id, week_key, candidate_date_iso, status, channel_id, deadline_at)
      SELECT 'session-' || n, 'week-' || n, '2026-04-24', 'COMPLETED', 'channel', '2026-04-24T12:30:00Z'
      FROM generate_series(1, ${count}) n`);
    await db.execute(sql`INSERT INTO discord_notifications
      (id, family, kind, dedupe_key, payload, payload_hash, status, cancel_reason, terminal_at, part_count, renderer_version)
      SELECT kind || n, 'attendance', 'send_message', kind || n, '{}'::jsonb, repeat('a', 64),
        CASE WHEN kind = 'failed-' THEN 'FAILED' ELSE 'CANCELLED' END,
        CASE WHEN kind = 'manual-' THEN 'manual_skip' WHEN kind = 'successor-' THEN 'predecessor_failed' END,
        '2026-04-24T12:30:00Z', 1, 1
      FROM generate_series(1, ${count}) n CROSS JOIN (VALUES ('failed-'), ('successor-'), ('manual-')) k(kind)`);
    await db.execute(sql`INSERT INTO discord_notification_attendance (notification_id, session_id, aggregate_revision, ordinal)
      SELECT kind || n, 'session-' || n, 1,
        CASE WHEN kind = 'failed-' THEN 0 WHEN kind = 'successor-' THEN 1 ELSE 2 END
      FROM generate_series(1, ${count}) n CROSS JOIN (VALUES ('failed-'), ('successor-'), ('manual-')) k(kind)`);
    await db.execute(sql`INSERT INTO discord_notification_parts
      (notification_id, part_no, status, attempt_count, send_started_at, delivered_at, delivered_message_id)
      SELECT id, 0, CASE WHEN starts_with(id, 'failed-') THEN 'DELIVERED' ELSE 'CANCELLED' END, 1,
        '2026-04-24T12:30:00Z',
        CASE WHEN starts_with(id, 'failed-') THEN '2026-04-24T12:30:00Z'::timestamptz END,
        CASE WHEN starts_with(id, 'failed-') THEN 'message-' || id END
      FROM discord_notifications`);

    expect(await requeueFailedOutboxChains(db, new Date("2026-04-25T00:00:00Z")))
      .toEqual({ deadLettersRequeued: count, successorsRequeued: count });
    const [parents] = await db.execute<{ pending: number; cancelled: number }>(sql`SELECT
      count(*) FILTER (WHERE status = 'PENDING')::int AS pending,
      count(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled FROM discord_notifications`);
    expect(parents).toEqual({ pending: count * 2, cancelled: count });
    const [parts] = await db.execute<{ pending: number; delivered: number; cancelled: number }>(sql`SELECT
      count(*) FILTER (WHERE status = 'PENDING')::int AS pending,
      count(*) FILTER (WHERE status = 'DELIVERED')::int AS delivered,
      count(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled FROM discord_notification_parts`);
    expect(parts).toEqual({ pending: count, delivered: count, cancelled: count });
    expect(await requeueFailedOutboxChains(db, new Date("2026-04-25T00:00:00Z")))
      .toEqual({ deadLettersRequeued: 0, successorsRequeued: 0 });
  });
});
