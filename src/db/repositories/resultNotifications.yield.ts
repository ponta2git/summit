import { and, eq, isNull, lte, ne, sql } from "drizzle-orm";
import { discordNotifications as notifications, discordNotificationParts as parts } from "../schema.ts";
import { ownsNotificationClaim } from "../../domain/notification.ts";
import { RESULT_NOTIFICATION_CLAIM_BUDGET_BYTES } from "../../notifications/config.ts";
import { cancelNotification, loadResultCancellationReason, lockNotification, type NotificationDb } from "./notifications.storage.ts";
import { supportedResultNotification } from "./notifications.supported.ts";

/** Hand off a live claim only between parts, without charging a failed delivery attempt. */
export const yieldResultNotification = async (tx: NotificationDb, id: string, token: string, now: Date): Promise<boolean> => {
  const row = await lockNotification(tx, id);
  if (!row || row.family !== "result" || !ownsNotificationClaim(row, token, now)) { return false; }
  const reason = await loadResultCancellationReason(tx, id);
  if (reason) { await cancelNotification(tx, id, reason, now); return false; }
  const [waiting] = await tx.select({ id: notifications.id }).from(notifications).where(and(
    eq(notifications.family, "result"), supportedResultNotification(), ne(notifications.kind, row.kind),
    eq(notifications.status, "PENDING"), lte(notifications.nextAttemptAt, now), isNull(notifications.purgedAt)
  )).limit(1);
  if (!waiting) { return false; }
  const changed = await tx.update(notifications).set({
    status: "PENDING", claimToken: null, claimExpiresAt: null, nextAttemptAt: now, updatedAt: now,
    // invariant: 次の claim の加算と相殺する。期限切れ・失敗経路の試行予算は戻さない。
    attemptCount: sql`${notifications.attemptCount} - 1`
  }).where(and(eq(notifications.id, id),
    sql`octet_length(${notifications.payload}::text) <= ${RESULT_NOTIFICATION_CLAIM_BUDGET_BYTES}`,
    sql`NOT EXISTS (SELECT 1 FROM ${parts} WHERE ${parts.notificationId} = ${id} AND ${parts.status} = 'IN_FLIGHT')`,
    sql`EXISTS (SELECT 1 FROM ${parts} WHERE ${parts.notificationId} = ${id} AND ${parts.status} = 'DELIVERED')`,
    sql`EXISTS (SELECT 1 FROM ${parts} WHERE ${parts.notificationId} = ${id} AND ${parts.status} = 'PENDING')`
  )).returning({ id: notifications.id });
  return changed.length === 1;
};
