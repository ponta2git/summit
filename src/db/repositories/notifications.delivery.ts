import { and, eq, gt, lt, ne } from "drizzle-orm";
import { discordNotifications as notifications, discordNotificationParts as parts } from "../schema.ts";
import { afterDeliveryFailure, ownsNotificationClaim, RESULT_DELIVERY_ERRORS } from "../../domain/notification.ts";
import { addMs } from "../../time/index.ts";
import { cancelAttendanceSuccessors } from "./notifications.claim.ts";
import { cancelNotification, loadResultCancellationReason, lockNotification, type NotificationDb, type NotificationFamily } from "./notifications.storage.ts";

export const beginNotificationPart = async (
  tx: NotificationDb, id: string, partNo: number, token: string, now: Date, family: NotificationFamily = "attendance"
): Promise<boolean> => {
  const row = await lockNotification(tx, id);
  if (!row || row.family !== family || !ownsNotificationClaim(row, token, now)) { return false; }
  if (row.family === "result") {
    const reason = await loadResultCancellationReason(tx, id);
    if (reason) { await cancelNotification(tx, id, reason, now); return false; }
  }
  const [previous] = await tx.select({ partNo: parts.partNo }).from(parts).where(and(
    eq(parts.notificationId, id), lt(parts.partNo, partNo), ne(parts.status, "DELIVERED")
  )).limit(1);
  if (previous || partNo < 0 || partNo >= row.partCount) { return false; }
  const [part] = await tx.select().from(parts).where(and(eq(parts.notificationId, id), eq(parts.partNo, partNo)));
  if (!part || part.status !== "PENDING") { return false; }
  await tx.update(parts).set({
    status: "IN_FLIGHT", claimToken: token, sendStartedAt: now, attemptCount: part.attemptCount + 1
  }).where(and(eq(parts.notificationId, id), eq(parts.partNo, partNo)));
  return true;
};

export const completeNotificationPart = async (
  tx: NotificationDb, id: string, partNo: number, token: string, messageId: string | null, now: Date, family: NotificationFamily = "attendance"
): Promise<boolean> => {
  const row = await lockNotification(tx, id);
  if (!row || row.family !== family || !ownsNotificationClaim(row, token, now, true)) { return false; }
  if (row.family === "result" && (!messageId || messageId.length > 200)) { throw new Error("Invalid delivered message ID"); }
  const changed = await tx.update(parts).set({
    status: "DELIVERED", deliveredAt: now, deliveredMessageId: messageId, claimToken: null
  }).where(and(eq(parts.notificationId, id), eq(parts.partNo, partNo), eq(parts.status, "IN_FLIGHT"), eq(parts.claimToken, token)))
    .returning({ partNo: parts.partNo });
  if (changed.length === 0) { return false; }
  const [unfinished] = await tx.select({ partNo: parts.partNo }).from(parts)
    .where(and(eq(parts.notificationId, id), ne(parts.status, "DELIVERED"))).limit(1);
  await tx.update(notifications).set(row.status === "CANCELLED"
    ? { claimToken: null, claimExpiresAt: null, updatedAt: now }
    : unfinished ? { updatedAt: now } : {
      status: "DELIVERED", deliveredAt: now, terminalAt: now, lastError: null,
      claimToken: null, claimExpiresAt: null, updatedAt: now
    }).where(eq(notifications.id, id));
  return true;
};

export const failNotification = async (
  tx: NotificationDb, id: string, token: string, error: string, nextAttemptAt: Date | null, now: Date, family: NotificationFamily = "attendance"
): Promise<boolean> => {
  const row = await lockNotification(tx, id);
  if (!row || row.family !== family || !ownsNotificationClaim(row, token, now, true)) { return false; }
  if ((nextAttemptAt && nextAttemptAt < now) || (row.family === "result"
    && !RESULT_DELIVERY_ERRORS.some(code => code === error))) { throw new Error("Invalid notification failure"); }
  const status = afterDeliveryFailure(row, nextAttemptAt !== null);
  await tx.update(parts).set({ status: status === "CANCELLED" ? status : "PENDING", claimToken: null })
    .where(and(eq(parts.notificationId, id), eq(parts.status, "IN_FLIGHT"), eq(parts.claimToken, token)));
  await tx.update(notifications).set({
    status, lastError: error.slice(0, 4000), claimToken: null, claimExpiresAt: null,
    nextAttemptAt: nextAttemptAt ?? now, updatedAt: now,
    terminalAt: status === "FAILED" ? now : status === "CANCELLED" ? row.terminalAt : null
  }).where(eq(notifications.id, id));
  if (status === "FAILED" && row.family === "attendance") { await cancelAttendanceSuccessors(tx, now); }
  return true;
};

export const renewNotificationClaim = async (
  tx: NotificationDb, id: string, token: string, now: Date, claimDurationMs: number, family: NotificationFamily = "attendance"
): Promise<boolean> => {
  if (claimDurationMs < 1 || claimDurationMs > 300_000) { throw new Error("Invalid notification claim duration"); }
  const changed = await tx.update(notifications).set({ claimExpiresAt: addMs(now, claimDurationMs), updatedAt: now })
    .where(and(eq(notifications.id, id), eq(notifications.family, family), eq(notifications.status, "IN_FLIGHT"), eq(notifications.claimToken, token), gt(notifications.claimExpiresAt, now)))
    .returning({ id: notifications.id });
  return changed.length === 1;
};
