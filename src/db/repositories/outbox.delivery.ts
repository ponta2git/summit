import type { DbLike } from "../rows.ts";
import { notificationTransaction } from "./notifications.storage.ts";
import { beginNotificationPart, completeNotificationPart, failNotification } from "./notifications.delivery.ts";

export const beginOutboxDelivery = (
  db: DbLike, id: string, options: { readonly claimToken: string; readonly now: Date }
): Promise<boolean> => notificationTransaction(db, "attendance", tx =>
  beginNotificationPart(tx, id, 0, options.claimToken, options.now));

export const markOutboxDelivered = (
  db: DbLike, id: string,
  options: { readonly claimToken: string; readonly deliveredMessageId: string | null; readonly now: Date }
): Promise<boolean> => notificationTransaction(db, "attendance", tx =>
  completeNotificationPart(tx, id, 0, options.claimToken, options.deliveredMessageId, options.now));

export const markOutboxFailed = (
  db: DbLike, id: string,
  options: { readonly error: string; readonly claimToken: string; readonly now: Date; readonly nextAttemptAt: Date | null }
): Promise<boolean> => notificationTransaction(db, "attendance", tx =>
  failNotification(tx, id, options.claimToken, options.error, options.nextAttemptAt, options.now));
