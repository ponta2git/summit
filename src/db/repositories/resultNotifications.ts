import { and, eq, isNull, notInArray, sql } from "drizzle-orm";
import { RESULT_NOTIFICATION_KINDS, discordNotifications as notifications } from "../schema.ts";
import { assertEnum, parseDbTimestamp, type DbLike } from "../rows.ts";
import type { ClaimedResultNotification, ResultNotificationsPort } from "../ports.resultNotifications.ts";
import { NotificationInputError } from "../../domain/resultNotificationPayload.ts";
import { notificationTransaction, type NotificationDb } from "./notifications.storage.ts";
import { claimNotifications } from "./notifications.claim.ts";
import { beginNotificationPart, completeNotificationPart, failNotification, renewNotificationClaim } from "./notifications.delivery.ts";
import { purgeNotifications } from "./notifications.retention.ts";
import { receiveResultNotification } from "./resultNotifications.receipt.ts";
import { planResultNotification } from "./resultNotifications.plan.ts";
import { getResultSetting, inspectResultNotification, loadResultParts, readDeliveryContext, retryResultNotification, setResultSetting } from "./resultNotifications.state.ts";

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
      const rows = await claimNotifications(tx, "result", options);
      const claimed: ClaimedResultNotification[] = [];
      for (const row of rows) {
        if (!row.claimToken) { throw new Error("Missing notification claim token"); }
        claimed.push({
          id: row.id, kind: assertEnum(RESULT_NOTIFICATION_KINDS, row.kind, "result notification kind"), payload: row.payload,
          claimToken: row.claimToken, attemptCount: row.attemptCount, maxAttempts: row.maxAttempts,
          partCount: row.partCount, rendererVersion: row.rendererVersion, deliveryContext: readDeliveryContext(row.deliveryContext),
          parts: await loadResultParts(tx, row.id)
        });
      }
      return claimed;
    }),
    plan: (id, token, options) => run(tx => planResultNotification(tx, id, token, options)),
    begin: (id, partNo, token, now) => run(tx => beginNotificationPart(tx, id, partNo, token, now, "result")),
    complete: (id, partNo, token, messageId, now) => run(tx => completeNotificationPart(tx, id, partNo, token, messageId, now, "result")),
    fail: (id, token, error, nextAttemptAt, now) => run(tx => failNotification(tx, id, token, error, nextAttemptAt, now, "result")),
    renew: (id, token, now, claimDurationMs) => run(tx => renewNotificationClaim(tx, id, token, now, claimDurationMs, "result")),
    getNextDispatchAt: (excludeIds = []) => db.select({ next: sql<unknown>`min(case
      when ${notifications.status} = 'PENDING' then ${notifications.nextAttemptAt}
      when ${notifications.claimToken} is not null then ${notifications.claimExpiresAt} else null end)` })
      .from(notifications).where(and(eq(notifications.family, "result"), isNull(notifications.purgedAt),
        excludeIds.length ? notInArray(notifications.id, [...excludeIds]) : undefined))
      .then(([row]) => parseDbTimestamp(row?.next, "next result notification dispatch")).catch(sanitizeFailure),
    inspect: id => run(tx => inspectResultNotification(tx, id)),
    retry: (id, now) => run(tx => retryResultNotification(tx, id, now)),
    prune: now => run(async tx => (await purgeNotifications(tx, "result", now, { deliveredOlderThan: now, failedOlderThan: now })).length),
    getSetting: kind => run(tx => getResultSetting(tx, kind)),
    setSetting: (kind, enabled, now) => run(tx => setResultSetting(tx, kind, enabled, now))
  };
};
