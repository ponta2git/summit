import { and, eq, inArray, sql } from "drizzle-orm";
import { RESULT_NOTIFICATION_LOCK_TIMEOUT_MS, RESULT_NOTIFICATION_SQL_TIMEOUT_MS } from "../../config.ts";
import type { DbLike } from "../rows.ts";
import {
  discordNotifications as notifications, discordNotificationParts as parts,
  discordNotificationResults as results, discordNotificationSettings as settings,
  discordNotificationTargets as targets, matchDrafts, matches
} from "../schema.ts";
import { resultCancellationReason, type ResultCancellationReason } from "../../domain/notification.ts";

export type NotificationFamily = "attendance" | "result";
export type NotificationRow = typeof notifications.$inferSelect;
export type NotificationDb = Pick<DbLike, "select" | "insert" | "update" | "delete" | "execute">;

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
  await tx.execute(sql`SELECT set_config('lock_timeout', ${String(RESULT_NOTIFICATION_LOCK_TIMEOUT_MS)}, true)`);
  await tx.execute(sql`SELECT set_config('statement_timeout', ${String(RESULT_NOTIFICATION_SQL_TIMEOUT_MS)}, true)`);
  await lockNotificationFamily(tx, family);
  return command(tx);
}, { isolationLevel: "read committed" });

export const lockNotification = async (tx: NotificationDb, id: string): Promise<NotificationRow | undefined> => {
  const [row] = await tx.select().from(notifications).where(eq(notifications.id, id)).for("update");
  return row;
};

/** Caller holds the family gate, or the attendance source aggregate transaction. */
export const cancelNotification = async (
  tx: NotificationDb, id: string, reason: string, now: Date
): Promise<boolean> => {
  const row = await lockNotification(tx, id);
  if (!row || row.status === "DELIVERED" || row.status === "CANCELLED" || row.purgedAt) { return false; }
  await tx.update(parts).set({ status: "CANCELLED", claimToken: null })
    .where(and(eq(parts.notificationId, id), eq(parts.status, "PENDING")));
  const [sending] = await tx.select({ partNo: parts.partNo }).from(parts)
    .where(and(eq(parts.notificationId, id), eq(parts.status, "IN_FLIGHT"))).limit(1);
  await tx.update(notifications).set({
    status: "CANCELLED", cancelReason: reason, terminalAt: now, updatedAt: now,
    claimToken: sending ? row.claimToken : null, claimExpiresAt: sending ? row.claimExpiresAt : null
  }).where(eq(notifications.id, id));
  return true;
};

/** Read cancellation evidence under the command's gate; never take source locks. */
export const loadResultCancellationReason = async (
  tx: NotificationDb, id: string
): Promise<ResultCancellationReason | null> => {
  const [context] = await tx.select({
    enabled: settings.enabled, currentGeneration: settings.generation, receivedGeneration: results.settingsGeneration
  }).from(results).innerJoin(settings, eq(settings.kind, results.kind)).where(eq(results.notificationId, id));
  if (!context) { throw new Error("Missing notification result context"); }
  const references = await tx.select().from(targets).where(eq(targets.notificationId, id));
  const draftIds = references.filter(target => target.targetKind === "match_draft").map(target => target.targetId);
  const matchIds = references.filter(target => target.targetKind === "match").map(target => target.targetId);
  const drafts = draftIds.length === 0 ? [] : await tx.select({
    id: matchDrafts.id, status: matchDrafts.status, confirmedMatchId: matchDrafts.confirmedMatchId
  }).from(matchDrafts).where(inArray(matchDrafts.id, draftIds));
  const retainedMatches = matchIds.length === 0 ? [] : await tx.select({ id: matches.id })
    .from(matches).where(inArray(matches.id, matchIds));
  return resultCancellationReason({
    ...context,
    unavailableDraft: drafts.length !== draftIds.length
      || drafts.some(draft => draft.status === "confirmed" || draft.status === "cancelled" || draft.confirmedMatchId !== null),
    deletedMatch: retainedMatches.length !== matchIds.length
  });
};
