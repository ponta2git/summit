import { randomUUID } from "node:crypto";
import { and, eq, getTableColumns, inArray, isNotNull, isNull, lte, notInArray, sql } from "drizzle-orm";
import { discordNotifications as notifications, discordNotificationParts as parts, discordNotificationAttendance as attendance } from "../schema.ts";
import { addMs } from "../../time/index.ts";
import { afterDeliveryFailure } from "../../domain/notification.ts";
import {
  cancelNotification, loadResultCancellationReason, type NotificationDb,
  type NotificationFamily, type NotificationRow
} from "./notifications.storage.ts";

export const cancelAttendanceSuccessors = async (tx: NotificationDb, now: Date): Promise<number> => {
  const rows = await tx.select({ id: notifications.id }).from(notifications)
    .innerJoin(attendance, eq(attendance.notificationId, notifications.id))
    .where(and(inArray(notifications.status, ["PENDING", "IN_FLIGHT"]), sql`EXISTS (
      SELECT 1 FROM discord_notification_attendance previous
      JOIN discord_notifications predecessor ON predecessor.id = previous.notification_id
      WHERE previous.session_id = ${attendance.sessionId} AND predecessor.status = 'FAILED'
        AND (previous.aggregate_revision, previous.ordinal) < (${attendance.aggregateRevision}, ${attendance.ordinal})
    )`)).orderBy(notifications.id);
  let count = 0;
  for (const row of rows) {
    if (await cancelNotification(tx, row.id, "predecessor_failed", now)) { count += 1; }
  }
  return count;
};

export const releaseExpiredNotificationClaims = async (
  tx: NotificationDb, family: NotificationFamily, now: Date
): Promise<number> => {
  const rows = await tx.select().from(notifications).where(and(
    eq(notifications.family, family), lte(notifications.claimExpiresAt, now),
    inArray(notifications.status, ["IN_FLIGHT", "CANCELLED"])
  )).orderBy(notifications.id).for("update", { skipLocked: true });
  for (const row of rows) {
    const status = afterDeliveryFailure(row, true);
    await tx.update(parts).set({ status: status === "CANCELLED" ? status : "PENDING", claimToken: null })
      .where(and(eq(parts.notificationId, row.id), eq(parts.status, "IN_FLIGHT")));
    await tx.update(notifications).set({
      status, claimToken: null, claimExpiresAt: null, nextAttemptAt: now, updatedAt: now,
      terminalAt: status === "FAILED" ? now : status === "CANCELLED" ? row.terminalAt : null,
      lastError: status === "FAILED" ? "attempt_limit" : row.lastError
    }).where(eq(notifications.id, row.id));
  }
  if (family === "attendance") { await cancelAttendanceSuccessors(tx, now); }
  return rows.length;
};

export interface NotificationClaimOptions {
  readonly limit: number;
  readonly now: Date;
  readonly claimDurationMs: number;
  readonly excludeIds?: readonly string[];
}

export const claimNotifications = async (
  tx: NotificationDb, family: NotificationFamily, options: NotificationClaimOptions
): Promise<readonly NotificationRow[]> => {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100
    || options.claimDurationMs < 1 || options.claimDurationMs > 300_000) {
    throw new Error("Invalid notification claim options");
  }
  await releaseExpiredNotificationClaims(tx, family, options.now);
  const rows = await tx.select(getTableColumns(notifications)).from(notifications)
    .leftJoin(attendance, eq(attendance.notificationId, notifications.id))
    .where(and(eq(notifications.family, family), eq(notifications.status, "PENDING"),
      lte(notifications.nextAttemptAt, options.now), isNull(notifications.purgedAt),
      options.excludeIds?.length ? notInArray(notifications.id, [...options.excludeIds]) : undefined,
      family === "result" ? undefined : and(isNotNull(attendance.sessionId), sql`NOT EXISTS (
        SELECT 1 FROM discord_notification_attendance previous
        JOIN discord_notifications predecessor ON predecessor.id = previous.notification_id
        WHERE previous.session_id = ${attendance.sessionId} AND predecessor.status IN ('PENDING','IN_FLIGHT','FAILED')
          AND (previous.aggregate_revision, previous.ordinal) < (${attendance.aggregateRevision}, ${attendance.ordinal})
      )`)))
    .orderBy(notifications.nextAttemptAt, attendance.sessionId, attendance.aggregateRevision, attendance.ordinal, notifications.id)
    .limit(options.limit).for("update", { of: notifications, skipLocked: true });
  const claimed: NotificationRow[] = [];
  for (const row of rows) {
    if (row.attemptCount >= row.maxAttempts) {
      await tx.update(notifications).set({ status: "FAILED", lastError: "attempt_limit", terminalAt: options.now, updatedAt: options.now })
        .where(eq(notifications.id, row.id));
      continue;
    }
    if (family === "result") {
      const reason = await loadResultCancellationReason(tx, row.id);
      if (reason) { await cancelNotification(tx, row.id, reason, options.now); continue; }
    }
    const [updated] = await tx.update(notifications).set({
      status: "IN_FLIGHT", claimToken: randomUUID(), claimExpiresAt: addMs(options.now, options.claimDurationMs),
      attemptCount: row.attemptCount + 1, updatedAt: options.now
    }).where(eq(notifications.id, row.id)).returning();
    if (updated) { claimed.push(updated); }
  }
  if (family === "attendance") { await cancelAttendanceSuccessors(tx, options.now); }
  return claimed;
};
