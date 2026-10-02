import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { OUTBOX_RETENTION_DELIVERED_MS, OUTBOX_RETENTION_FAILED_MS } from "../../config.ts";
import { addMs } from "../../time/index.ts";
import { NOTIFICATION_MAINTENANCE_BATCH_SIZE, NOTIFICATION_RETENTION_MAX_BATCHES } from "../../notifications/config.ts";
import { discordNotifications as notifications, discordNotificationParts as parts, discordNotificationTargets as targets } from "../schema.ts";
import type { DbLike } from "../rows.ts";
import { notificationTransaction, type NotificationDb, type NotificationFamily } from "./notifications.storage.ts";

interface NotificationPurgeCounts {
  readonly deliveredPruned: number;
  readonly failedPruned: number;
  readonly cancelledPruned: number;
}

/** Purge one bounded, atomic batch; retain identities and every claimed delivery. */
export const purgeNotifications = async (
  tx: NotificationDb, family: NotificationFamily, now: Date,
  cutoffs: { readonly deliveredOlderThan: Date; readonly failedOlderThan: Date }
): Promise<NotificationPurgeCounts> => {
  const deliveredCutoff = addMs(now, -OUTBOX_RETENTION_DELIVERED_MS);
  const failedCutoff = addMs(now, -OUTBOX_RETENTION_FAILED_MS);
  const deliveredBefore = cutoffs.deliveredOlderThan < deliveredCutoff ? cutoffs.deliveredOlderThan : deliveredCutoff;
  const failedBefore = cutoffs.failedOlderThan < failedCutoff ? cutoffs.failedOlderThan : failedCutoff;
  const counts = { deliveredPruned: 0, failedPruned: 0, cancelledPruned: 0 };
  const rows = await tx.select({ id: notifications.id, status: notifications.status })
    .from(notifications).where(and(
      eq(notifications.family, family), isNull(notifications.purgedAt), isNull(notifications.claimToken),
      or(and(eq(notifications.status, "DELIVERED"), lte(notifications.terminalAt, deliveredBefore)),
        and(inArray(notifications.status, ["FAILED", "CANCELLED"]), lte(notifications.terminalAt, failedBefore))),
      sql`NOT EXISTS (SELECT 1 FROM discord_notification_parts p
        WHERE p.notification_id = ${notifications.id} AND p.status = 'IN_FLIGHT')`
    )).orderBy(notifications.id).limit(NOTIFICATION_MAINTENANCE_BATCH_SIZE).for("update", { skipLocked: true });
  if (rows.length === 0) { return counts; }
  const ids = rows.map(row => row.id);
  await tx.update(notifications).set({ payload: null, deliveryContext: null, purgedAt: now, lastError: null, updatedAt: now })
    .where(inArray(notifications.id, ids));
  await tx.delete(parts).where(inArray(parts.notificationId, ids));
  await tx.delete(targets).where(inArray(targets.notificationId, ids));
  for (const row of rows) {
    if (row.status === "DELIVERED") { counts.deliveredPruned += 1; }
    else if (row.status === "FAILED") { counts.failedPruned += 1; }
    else { counts.cancelledPruned += 1; }
  }
  return counts;
};

/** Release the family gate between batches and leave excess work for the next retention pass. */
export const pruneNotificationBatches = async (
  db: DbLike, family: NotificationFamily, now: Date,
  cutoffs: { readonly deliveredOlderThan: Date; readonly failedOlderThan: Date }
): Promise<NotificationPurgeCounts> => {
  const total = { deliveredPruned: 0, failedPruned: 0, cancelledPruned: 0 };
  for (let batch = 0; batch < NOTIFICATION_RETENTION_MAX_BATCHES; batch += 1) {
    const counts = await notificationTransaction(db, family, tx => purgeNotifications(tx, family, now, cutoffs));
    total.deliveredPruned += counts.deliveredPruned;
    total.failedPruned += counts.failedPruned;
    total.cancelledPruned += counts.cancelledPruned;
    if (counts.deliveredPruned + counts.failedPruned + counts.cancelledPruned < NOTIFICATION_MAINTENANCE_BATCH_SIZE) { break; }
  }
  return total;
};
