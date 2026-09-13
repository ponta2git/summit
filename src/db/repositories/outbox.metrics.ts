import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { discordNotificationAttendance, discordNotifications, OUTBOX_STATUSES } from "../schema.ts";
import { assertEnum, parseDbTimestamp, type DbLike } from "../rows.ts";
import type { OutboxDiagnostic } from "./outbox.types.ts";
import { notificationTransaction } from "./notifications.storage.ts";
import { purgeNotifications } from "./notifications.retention.ts";
import { findNextNotificationDispatchAt } from "./notifications.dispatch.ts";
import { systemClock } from "../../time/index.ts";

const retainedAttendance = and(eq(discordNotifications.family, "attendance"), isNull(discordNotifications.purgedAt));

export const findStrandedOutboxEntries = async (
  db: DbLike, attemptsThreshold: number
): Promise<readonly OutboxDiagnostic[]> => {
  // Diagnostics must remain available even when the stored delivery body is malformed.
  const rows = await db.select({ id: discordNotifications.id, sessionId: discordNotificationAttendance.sessionId,
    dedupeKey: discordNotifications.dedupeKey, status: discordNotifications.status, attemptCount: discordNotifications.attemptCount, createdAt: discordNotifications.createdAt })
    .from(discordNotifications)
    .innerJoin(discordNotificationAttendance, eq(discordNotificationAttendance.notificationId, discordNotifications.id))
    .where(and(retainedAttendance, or(eq(discordNotifications.status, "FAILED"),
      and(inArray(discordNotifications.status, ["PENDING", "IN_FLIGHT"]), sql`${discordNotifications.attemptCount} >= ${attemptsThreshold}`))))
    .orderBy(discordNotifications.createdAt, discordNotifications.id);
  return rows.flatMap(row => row.sessionId === null ? [] : [{ ...row, sessionId: row.sessionId,
    status: assertEnum(OUTBOX_STATUSES, row.status, "outbox status") }]);
};

export interface PruneOutboxResult {
  readonly deliveredPruned: number;
  readonly failedPruned: number;
  readonly cancelledPruned: number;
}

/** Purge delivery detail while retaining the permanent dedupe identity. */
export const pruneOutbox = async (
  db: DbLike,
  options: { readonly deliveredOlderThan: Date; readonly failedOlderThan: Date }
): Promise<PruneOutboxResult> => notificationTransaction(db, "attendance", tx =>
  purgeNotifications(tx, "attendance", systemClock.now(), options));

export interface OutboxMetricsResult {
  readonly pending: number;
  readonly inFlight: number;
  readonly failed: number;
  readonly oldestPendingAgeMs: number | null;
  readonly oldestFailedAgeMs: number | null;
}

export const getOutboxMetrics = async (db: DbLike, now: Date): Promise<OutboxMetricsResult> => {
  const [row] = await db.select({
    pending: sql<number>`count(*) filter (where ${discordNotifications.status} = 'PENDING')::int`,
    inFlight: sql<number>`count(*) filter (where ${discordNotifications.status} = 'IN_FLIGHT')::int`,
    failed: sql<number>`count(*) filter (where ${discordNotifications.status} = 'FAILED')::int`,
    oldestPending: sql<unknown>`min(${discordNotifications.createdAt}) filter (where ${discordNotifications.status} = 'PENDING')`,
    oldestFailed: sql<unknown>`min(${discordNotifications.updatedAt}) filter (where ${discordNotifications.status} = 'FAILED')`
  }).from(discordNotifications).where(retainedAttendance);
  const age = (value: unknown, label: string): number | null => {
    const date = parseDbTimestamp(value, label);
    return date === null ? null : Math.max(0, now.getTime() - date.getTime());
  };
  return {
    pending: Number(row?.pending ?? 0), inFlight: Number(row?.inFlight ?? 0), failed: Number(row?.failed ?? 0),
    oldestPendingAgeMs: age(row?.oldestPending ?? null, "oldest pending notification"),
    oldestFailedAgeMs: age(row?.oldestFailed ?? null, "oldest failed notification")
  };
};

export const getNextOutboxDispatchAt = (db: DbLike, _now: Date): Promise<Date | null> =>
  findNextNotificationDispatchAt(db, "attendance");
