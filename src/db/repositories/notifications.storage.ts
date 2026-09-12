import { and, eq, gt, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { RESULT_NOTIFICATION_LOCK_TIMEOUT_MS, RESULT_NOTIFICATION_SQL_TIMEOUT_MS } from "../../config.ts";
import type { DbLike } from "../rows.ts";
import {
  discordNotifications as notifications, discordNotificationParts as parts,
  discordNotificationResults as results, discordNotificationSettings as settings,
  discordNotificationTargets as targets, matchDrafts, matches
} from "../schema.ts";
import { resultCancellationReason, type ResultCancellationReason } from "../../domain/notification.ts";

export type NotificationFamily = "attendance" | "result";
export type NotificationDb = Pick<DbLike, "select" | "insert" | "update" | "delete" | "execute">;

// why: claim の制御や各 part の更新では、大きな immutable payload を読み直さない。
export const notificationStateColumns = {
  id: notifications.id, family: notifications.family, status: notifications.status,
  claimToken: notifications.claimToken, claimExpiresAt: notifications.claimExpiresAt,
  attemptCount: notifications.attemptCount, maxAttempts: notifications.maxAttempts, retryCycle: notifications.retryCycle,
  partCount: notifications.partCount, rendererVersion: notifications.rendererVersion,
  deliveryContext: notifications.deliveryContext, purgedAt: notifications.purgedAt,
  terminalAt: notifications.terminalAt, lastError: notifications.lastError
};
type NotificationStateRow = Pick<typeof notifications.$inferSelect, keyof typeof notificationStateColumns>;

/**
 * The command owns the atomic boundary. Source writers take the result gate only
 * after their source writes; these commands never lock source rows after it.
 * READ COMMITTED then sees those writes after waiting. No Discord I/O belongs here.
 */
export const lockNotificationFamily = async (tx: NotificationDb, family: NotificationFamily): Promise<void> => {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(19790514, ${family === "result" ? 1 : 2})`);
};

export const notificationTransaction = <T>(
  db: DbLike, family: NotificationFamily, command: (tx: NotificationDb) => Promise<T>
): Promise<T> => db.transaction(async tx => {
  // Bound the shared gate and every SQL statement even when the HTTP caller leaves.
  await tx.execute(sql`SELECT
    set_config('lock_timeout', ${String(RESULT_NOTIFICATION_LOCK_TIMEOUT_MS)}, true),
    set_config('statement_timeout', ${String(RESULT_NOTIFICATION_SQL_TIMEOUT_MS)}, true)`);
  await lockNotificationFamily(tx, family);
  return command(tx);
}, { isolationLevel: "read committed" });

export const lockNotification = async (tx: NotificationDb, id: string): Promise<NotificationStateRow | undefined> => {
  const [row] = await tx.select(notificationStateColumns).from(notifications).where(eq(notifications.id, id)).for("update");
  return row;
};

/** Caller holds the family gate, or the attendance source aggregate transaction. */
export const cancelNotification = async (
  tx: NotificationDb, id: string, reason: string, now: Date
): Promise<boolean> => {
  const row = await lockNotification(tx, id);
  if (!row || row.status === "DELIVERED" || row.status === "CANCELLED" || row.purgedAt) { return false; }
  await cancelLockedNotifications(tx, [id], reason, now);
  return true;
};

/** All selected parents stay locked until the caller commits its setting/source change. */
export const cancelMatchingResultNotifications = async (
  tx: NotificationDb, predicate: SQL, reason: ResultCancellationReason, now: Date
): Promise<void> => {
  const batchSize = 256;
  let after: string | undefined;
  for (;;) {
    const rows = await tx.select({ id: notifications.id }).from(notifications).where(and(
      eq(notifications.family, "result"), isNull(notifications.purgedAt),
      inArray(notifications.status, ["PENDING", "IN_FLIGHT", "FAILED"]), predicate,
      after === undefined ? undefined : gt(notifications.id, after)
    )).orderBy(notifications.id).limit(batchSize).for("update");
    if (rows.length === 0) { return; }
    await cancelLockedNotifications(tx, rows.map(row => row.id), reason, now);
    if (rows.length < batchSize) { return; }
    after = rows.at(-1)?.id;
  }
};

/** Parents are already locked; read send evidence in a later statement after any lock wait. */
const cancelLockedNotifications = async (
  tx: NotificationDb, ids: readonly string[], reason: string, now: Date
): Promise<void> => {
  await tx.update(parts).set({ status: "CANCELLED", claimToken: null })
    .where(and(inArray(parts.notificationId, [...ids]), eq(parts.status, "PENDING")));
  const sending = sql`EXISTS (SELECT 1 FROM ${parts}
    WHERE ${parts.notificationId} = ${notifications.id} AND ${parts.status} = 'IN_FLIGHT')`;
  await tx.update(notifications).set({
    status: "CANCELLED", cancelReason: reason, terminalAt: now, updatedAt: now,
    claimToken: sql`CASE WHEN ${sending} THEN ${notifications.claimToken} END`,
    claimExpiresAt: sql`CASE WHEN ${sending} THEN ${notifications.claimExpiresAt} END`
  }).where(inArray(notifications.id, [...ids]));
};

/** Read cancellation evidence under the command's gate; never take source locks. */
export const loadResultCancellationReason = async (
  tx: NotificationDb, id: string
): Promise<ResultCancellationReason | null> => {
  const [context] = await tx.select({
    enabled: settings.enabled, currentGeneration: settings.generation, receivedGeneration: results.settingsGeneration
  }).from(results).innerJoin(settings, eq(settings.kind, results.kind)).where(eq(results.notificationId, id));
  if (!context) { throw new Error("Missing notification result context"); }
  const references = await tx.select({
    kind: targets.targetKind, draftId: matchDrafts.id, draftStatus: matchDrafts.status,
    confirmedMatchId: matchDrafts.confirmedMatchId, matchId: matches.id
  }).from(targets)
    .leftJoin(matchDrafts, and(eq(targets.targetKind, "match_draft"), eq(matchDrafts.id, targets.targetId)))
    .leftJoin(matches, and(eq(targets.targetKind, "match"), eq(matches.id, targets.targetId)))
    .where(eq(targets.notificationId, id));
  return resultCancellationReason({
    ...context,
    unavailableDraft: references.some(target => target.kind === "match_draft" && (target.draftId === null
      || target.draftStatus === "confirmed" || target.draftStatus === "cancelled" || target.confirmedMatchId !== null)),
    deletedMatch: references.some(target => target.kind === "match" && target.matchId === null)
  });
};
