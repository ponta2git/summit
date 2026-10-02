import { and, eq, gt, isNotNull, isNull, inArray, sql } from "drizzle-orm";
import type { DbLike } from "../rows.ts";
import { discordNotifications as notifications, discordNotificationAttendance as attendance } from "../schema.ts";
import { notificationTransaction } from "./notifications.storage.ts";
import { NOTIFICATION_MAINTENANCE_BATCH_SIZE } from "../../notifications/config.ts";

export interface RequeueFailedOutboxChainsResult {
  readonly deadLettersRequeued: number;
  readonly successorsRequeued: number;
}

/** Recover complete Session chains, releasing the family gate between bounded Session pages. */
export const requeueFailedOutboxChains = async (
  db: DbLike, now: Date
): Promise<RequeueFailedOutboxChainsResult> => {
  const total = { deadLettersRequeued: 0, successorsRequeued: 0 };
  let after: string | undefined;
  for (;;) {
    const batch = await notificationTransaction(db, "attendance", async tx => {
      const rows = await tx.select({ sessionId: attendance.sessionId }).from(notifications)
        .innerJoin(attendance, eq(attendance.notificationId, notifications.id))
        .where(and(eq(notifications.family, "attendance"), eq(notifications.status, "FAILED"),
          isNull(notifications.purgedAt), isNotNull(attendance.sessionId),
          after === undefined ? undefined : gt(attendance.sessionId, after)))
        .groupBy(attendance.sessionId).orderBy(attendance.sessionId).limit(NOTIFICATION_MAINTENANCE_BATCH_SIZE);
      const ids = rows.flatMap(row => row.sessionId === null ? [] : [row.sessionId]);
      if (ids.length === 0) { return undefined; }
      // why: チェーンの途中で commit しない。通知全件の ID 配列や巨大 IN bind を作らず DB 内で更新する。
      const [counts] = await tx.execute<{ deadLettersRequeued: number; successorsRequeued: number }>(sql`
        WITH candidates AS MATERIALIZED (
          SELECT n.id, n.status FROM discord_notifications n
          JOIN discord_notification_attendance a ON a.notification_id = n.id
          WHERE n.family = 'attendance' AND n.purged_at IS NULL AND ${inArray(sql`a.session_id`, ids)}
            AND (n.status = 'FAILED' OR (n.status = 'CANCELLED' AND n.claim_token IS NULL
              AND (n.cancel_reason = 'predecessor_failed' OR n.cancel_reason IS NULL)
              AND EXISTS (SELECT 1 FROM discord_notification_attendance previous
                JOIN discord_notifications predecessor ON predecessor.id = previous.notification_id
                WHERE previous.session_id = a.session_id AND predecessor.family = 'attendance'
                  AND predecessor.status = 'FAILED' AND predecessor.purged_at IS NULL
                  AND (previous.aggregate_revision, previous.ordinal) < (a.aggregate_revision, a.ordinal))))
          ORDER BY n.id FOR UPDATE OF n
        ), reset_parts AS (
          UPDATE discord_notification_parts SET status = 'PENDING', claim_token = NULL
          WHERE notification_id IN (SELECT id FROM candidates) AND status <> 'DELIVERED'
          RETURNING notification_id
        ), reset_parents AS (
          UPDATE discord_notifications SET status = 'PENDING', attempt_count = 0, retry_cycle = retry_cycle + 1,
            last_error = NULL, cancel_reason = NULL, claim_token = NULL, claim_expires_at = NULL,
            terminal_at = NULL, next_attempt_at = ${now.toISOString()}, updated_at = ${now.toISOString()}
          WHERE id IN (SELECT id FROM candidates) RETURNING id
        ) SELECT count(*) FILTER (WHERE c.status = 'FAILED')::int AS "deadLettersRequeued",
          count(*) FILTER (WHERE c.status = 'CANCELLED')::int AS "successorsRequeued"
          FROM candidates c JOIN reset_parents r USING (id)
      `);
      if (!counts) { throw new Error("Missing outbox recovery counts"); }
      return { counts, last: ids.at(-1), full: ids.length === NOTIFICATION_MAINTENANCE_BATCH_SIZE };
    });
    if (!batch) { return total; }
    total.deadLettersRequeued += batch.counts.deadLettersRequeued;
    total.successorsRequeued += batch.counts.successorsRequeued;
    if (!batch.full) { return total; }
    after = batch.last;
  }
};
