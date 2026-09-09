import { and, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { OUTBOX_RETENTION_DELIVERED_MS, OUTBOX_RETENTION_FAILED_MS } from "../../config.ts";
import { addMs } from "../../time/index.ts";
import { discordNotifications as notifications, discordNotificationParts as parts, discordNotificationTargets as targets } from "../schema.ts";
import type { NotificationDb, NotificationFamily } from "./notifications.storage.ts";

/** Retain identity forever; only terminal, unclaimed delivery detail may expire. */
export const purgeNotifications = async (
  tx: NotificationDb, family: NotificationFamily, now: Date,
  cutoffs: { readonly deliveredOlderThan: Date; readonly failedOlderThan: Date }
): Promise<readonly { readonly status: string }[]> => {
  const rows = await tx.select({ id: notifications.id, status: notifications.status, terminalAt: notifications.terminalAt })
    .from(notifications).where(and(
      eq(notifications.family, family), isNull(notifications.purgedAt), isNull(notifications.claimToken),
      inArray(notifications.status, ["DELIVERED", "FAILED", "CANCELLED"]),
      lte(notifications.terminalAt, now),
      sql`NOT EXISTS (SELECT 1 FROM discord_notification_parts p
        WHERE p.notification_id = ${notifications.id} AND p.status = 'IN_FLIGHT')`
    )).orderBy(notifications.id).for("update", { skipLocked: true });
  const eligible = rows.filter(row => row.terminalAt !== null
    && row.terminalAt <= (row.status === "DELIVERED" ? cutoffs.deliveredOlderThan : cutoffs.failedOlderThan)
    && row.terminalAt <= addMs(now, -(row.status === "DELIVERED" ? OUTBOX_RETENTION_DELIVERED_MS : OUTBOX_RETENTION_FAILED_MS)));
  for (const row of eligible) {
    await tx.update(notifications).set({ payload: null, deliveryContext: null, purgedAt: now, lastError: null, updatedAt: now })
      .where(eq(notifications.id, row.id));
    await tx.delete(parts).where(eq(parts.notificationId, row.id));
    await tx.delete(targets).where(eq(targets.notificationId, row.id));
  }
  return eligible;
};
