import type { DbLike } from "../rows.ts";
import { notificationTransaction } from "./notifications.storage.ts";
import { beginNotificationPart, completeNotificationPart, failNotification, renewNotificationClaim } from "./notifications.delivery.ts";
import { systemClock, type Clock } from "../../time/index.ts";
import { notificationCommandNow, type ClaimLease } from "../../time/lease.ts";

export const beginOutboxDelivery = (
  db: DbLike, id: string, options: { readonly claimToken: string; readonly now: Date }, clock: Clock = systemClock
): Promise<boolean> => notificationTransaction(db, "attendance", tx =>
  beginNotificationPart(tx, id, 0, options.claimToken, notificationCommandNow(clock, options.now)));

export const renewOutboxClaim = (
  db: DbLike, id: string,
  options: { readonly claimToken: string; readonly now: Date; readonly claimDurationMs: number }, clock: Clock = systemClock
): Promise<ClaimLease | null> => notificationTransaction(db, "attendance", tx =>
  renewNotificationClaim(tx, id, options.claimToken, options.now, options.claimDurationMs, "attendance", clock));

export const markOutboxDelivered = (
  db: DbLike, id: string,
  options: { readonly claimToken: string; readonly deliveredMessageId: string | null; readonly now: Date }, clock: Clock = systemClock
): Promise<boolean> => notificationTransaction(db, "attendance", tx =>
  completeNotificationPart(tx, id, 0, options.claimToken, options.deliveredMessageId, notificationCommandNow(clock, options.now)));

export const markOutboxFailed = (
  db: DbLike, id: string,
  options: { readonly error: string; readonly claimToken: string; readonly now: Date; readonly nextAttemptAt: Date | null }, clock: Clock = systemClock
): Promise<boolean> => notificationTransaction(db, "attendance", tx => {
  const now = notificationCommandNow(clock, options.now);
  return failNotification(tx, id, options.claimToken, options.error,
    options.nextAttemptAt && options.nextAttemptAt < now ? now : options.nextAttemptAt, now);
});
