import { and, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import type { DbLike } from "../rows.ts";
import { discordNotifications as notifications, discordNotificationAttendance as attendance, discordNotificationParts as parts } from "../schema.ts";
import { notificationTransaction } from "./notifications.storage.ts";

export interface RequeueFailedOutboxChainsResult {
  readonly deadLettersRequeued: number;
  readonly successorsRequeued: number;
}

/** Only the application startup command may revive retained attendance chains. */
export const requeueFailedOutboxChains = (
  db: DbLike, now: Date
): Promise<RequeueFailedOutboxChainsResult> => notificationTransaction(db, "attendance", async tx => {
  const failed = await tx.select({ id: notifications.id }).from(notifications)
    .innerJoin(attendance, eq(attendance.notificationId, notifications.id))
    .where(and(eq(notifications.family, "attendance"), eq(notifications.status, "FAILED"),
      isNull(notifications.purgedAt), isNotNull(attendance.sessionId)))
    .orderBy(notifications.id).for("update", { of: notifications });
  if (failed.length === 0) { return { deadLettersRequeued: 0, successorsRequeued: 0 }; }
  const failedIds = failed.map(row => row.id);
  const successors = await tx.select({ id: notifications.id }).from(notifications)
    .innerJoin(attendance, eq(attendance.notificationId, notifications.id))
    .where(and(eq(notifications.family, "attendance"), eq(notifications.status, "CANCELLED"),
      isNull(notifications.purgedAt), isNull(notifications.claimToken),
      or(eq(notifications.cancelReason, "predecessor_failed"), isNull(notifications.cancelReason)),
      sql`EXISTS (SELECT 1 FROM discord_notification_attendance previous
        WHERE ${inArray(sql`previous.notification_id`, failedIds)} AND previous.session_id = ${attendance.sessionId}
          AND (previous.aggregate_revision, previous.ordinal) < (${attendance.aggregateRevision}, ${attendance.ordinal}))`
    )).orderBy(notifications.id).for("update", { of: notifications });
  const ids = [...failedIds, ...successors.map(row => row.id)];
  await tx.update(parts).set({ status: "PENDING", claimToken: null })
    .where(and(inArray(parts.notificationId, ids), ne(parts.status, "DELIVERED")));
  await tx.update(notifications).set({
    status: "PENDING", attemptCount: 0, retryCycle: sql`${notifications.retryCycle} + 1`,
    lastError: null, cancelReason: null, claimToken: null, claimExpiresAt: null, terminalAt: null,
    nextAttemptAt: now, updatedAt: now
  }).where(inArray(notifications.id, ids));
  return { deadLettersRequeued: failed.length, successorsRequeued: successors.length };
});
