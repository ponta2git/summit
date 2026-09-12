import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { OUTBOX_RETENTION_DELIVERED_MS, OUTBOX_RETENTION_FAILED_MS } from "../../config.ts";
import { addMs } from "../../time/index.ts";
import { discordNotifications as notifications, discordNotificationParts as parts, discordNotificationTargets as targets } from "../schema.ts";
import type { NotificationDb, NotificationFamily } from "./notifications.storage.ts";

/** Retain identity forever; only terminal, unclaimed delivery detail may expire. */
export const purgeNotifications = async (
  tx: NotificationDb, family: NotificationFamily, now: Date,
  cutoffs: { readonly deliveredOlderThan: Date; readonly failedOlderThan: Date }
): Promise<readonly { readonly status: string }[]> => {
  const deliveredCutoff = addMs(now, -OUTBOX_RETENTION_DELIVERED_MS);
  const failedCutoff = addMs(now, -OUTBOX_RETENTION_FAILED_MS);
  const deliveredBefore = cutoffs.deliveredOlderThan < deliveredCutoff ? cutoffs.deliveredOlderThan : deliveredCutoff;
  const failedBefore = cutoffs.failedOlderThan < failedCutoff ? cutoffs.failedOlderThan : failedCutoff;
  const rows = await tx.select({ id: notifications.id, status: notifications.status })
    .from(notifications).where(and(
      eq(notifications.family, family), isNull(notifications.purgedAt), isNull(notifications.claimToken),
      or(and(eq(notifications.status, "DELIVERED"), lte(notifications.terminalAt, deliveredBefore)),
        and(inArray(notifications.status, ["FAILED", "CANCELLED"]), lte(notifications.terminalAt, failedBefore))),
      sql`NOT EXISTS (SELECT 1 FROM discord_notification_parts p
        WHERE p.notification_id = ${notifications.id} AND p.status = 'IN_FLIGHT')`
    )).orderBy(notifications.id).for("update", { skipLocked: true });
  for (let offset = 0; offset < rows.length; offset += 1_000) {
    const ids = rows.slice(offset, offset + 1_000).map(row => row.id);
    await tx.update(notifications).set({ payload: null, deliveryContext: null, purgedAt: now, lastError: null, updatedAt: now })
      .where(inArray(notifications.id, ids));
    await tx.delete(parts).where(inArray(parts.notificationId, ids));
    await tx.delete(targets).where(inArray(targets.notificationId, ids));
  }
  return rows;
};
