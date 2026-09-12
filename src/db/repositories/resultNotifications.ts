import type { DbLike } from "../rows.ts";
import type { ResultNotificationsPort } from "../ports.resultNotifications.ts";
import { NotificationInputError } from "../../domain/resultNotificationPayload.ts";
import { notificationTransaction, type NotificationDb } from "./notifications.storage.ts";
import { claimNotifications } from "./notifications.claim.ts";
import { beginNotificationPart, completeNotificationPart, failNotification, renewNotificationClaim } from "./notifications.delivery.ts";
import { purgeNotifications } from "./notifications.retention.ts";
import { findNextNotificationDispatchAt } from "./notifications.dispatch.ts";
import { receiveResultNotification } from "./resultNotifications.receipt.ts";
import { planResultNotification } from "./resultNotifications.plan.ts";
import { findClaimedResultNotifications, getResultSetting, inspectResultNotification, retryResultNotification, setResultSetting } from "./resultNotifications.state.ts";

/** Keep driver errors (which may embed bound payloads) behind the port boundary. */
const sanitizeFailure = (error: unknown): never => {
  if (error instanceof NotificationInputError) { throw error; }
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth += 1) {
    if ("code" in current && ["22P02", "22P05", "22003", "22007", "22008"].includes(String(current.code))) {
      throw new NotificationInputError("invalid_input");
    }
    current = "cause" in current ? current.cause : null;
  }
  throw new Error("Notification database operation failed");
};

export const makeResultNotificationsPort = (db: DbLike): ResultNotificationsPort => {
  const run = <T>(command: (tx: NotificationDb) => Promise<T>): Promise<T> =>
    notificationTransaction(db, "result", command).catch(sanitizeFailure);
  return {
    receive: (rawJson, now) => run(tx => receiveResultNotification(tx, rawJson, now)),
    claim: options => run(async tx => {
      const ids = await claimNotifications(tx, "result", options);
      return findClaimedResultNotifications(tx, ids);
    }),
    plan: (id, token, options) => run(tx => planResultNotification(tx, id, token, options)),
    begin: (id, partNo, token, now) => run(tx => beginNotificationPart(tx, id, partNo, token, now, "result")),
    complete: (id, partNo, token, messageId, now) => run(tx => completeNotificationPart(tx, id, partNo, token, messageId, now, "result")),
    fail: (id, token, error, nextAttemptAt, now) => run(tx => failNotification(tx, id, token, error, nextAttemptAt, now, "result")),
    renew: (id, token, now, claimDurationMs) => run(tx => renewNotificationClaim(tx, id, token, now, claimDurationMs, "result")),
    getNextDispatchAt: excludeIds => findNextNotificationDispatchAt(db, "result", excludeIds).catch(sanitizeFailure),
    inspect: id => run(tx => inspectResultNotification(tx, id)),
    retry: (id, now) => run(tx => retryResultNotification(tx, id, now)),
    prune: now => run(async tx => {
      const counts = await purgeNotifications(tx, "result", now, { deliveredOlderThan: now, failedOlderThan: now });
      return counts.deliveredPruned + counts.failedPruned + counts.cancelledPruned;
    }),
    getSetting: kind => run(tx => getResultSetting(tx, kind)),
    setSetting: (kind, enabled, now) => run(tx => setResultSetting(tx, kind, enabled, now))
  };
};
