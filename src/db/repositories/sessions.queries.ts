// source-of-truth: sessions repository のクエリ群。write なし。
// @see ADR-0038

import { and, eq, inArray, isNull, lte } from "drizzle-orm";

import { sessions } from "../schema.js";
import type { DbLike, SessionRow } from "../rows.js";
import { NON_TERMINAL_STATUSES, mapSession } from "./sessions.internal.js";

export const findSessionByWeekKeyAndPostponeCount = async (
  db: DbLike,
  weekKey: string,
  postponeCount: number
): Promise<SessionRow | undefined> => {
  const rows = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.weekKey, weekKey),
        eq(sessions.postponeCount, postponeCount)
      )
    )
    .limit(1);
  const row = rows[0];
  return row ? mapSession(row) : undefined;
};

export const findSessionById = async (
  db: DbLike,
  id: string
): Promise<SessionRow | undefined> => {
  const rows = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, id))
    .limit(1);
  const row = rows[0];
  return row ? mapSession(row) : undefined;
};

export const findDueAskingSessions = async (
  db: DbLike,
  now: Date
): Promise<SessionRow[]> => {
  const rows = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.status, "ASKING"), lte(sessions.deadlineAt, now)));
  return rows.map(mapSession);
};

export const findDuePostponeVotingSessions = async (
  db: DbLike,
  now: Date
): Promise<SessionRow[]> => {
  const rows = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.status, "POSTPONE_VOTING"), lte(sessions.deadlineAt, now)));
  return rows.map(mapSession);
};

/**
 * Find DECIDED sessions whose reminder is due and not yet sent.
 *
 * @remarks
 * idempotent: cron (毎分) と起動時リカバリ双方から呼ばれるが `reminder_sent_at IS NULL` 条件で再送を防ぐ。
 * @see requirements/base.md §5.2, ADR-0024
 */
export const findDueReminderSessions = async (
  db: DbLike,
  now: Date
): Promise<SessionRow[]> => {
  const rows = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.status, "DECIDED"),
        isNull(sessions.reminderSentAt),
        lte(sessions.reminderAt, now)
      )
    );
  return rows.map(mapSession);
};

export const findNonTerminalSessions = async (
  db: DbLike
): Promise<SessionRow[]> => {
  const rows = await db
    .select()
    .from(sessions)
    .where(inArray(sessions.status, [...NON_TERMINAL_STATUSES]));
  return rows.map(mapSession);
};

/**
 * Return sessions currently in `CANCELLED` status.
 *
 * @remarks
 * `CANCELLED` は短命中間状態 (ADR-0001)。空でなければ crash 由来の宙づり。Startup reconciler から呼ばれる。
 * @see ADR-0033
 */
export const findStrandedCancelledSessions = async (
  db: DbLike
): Promise<SessionRow[]> => {
  const rows = await db
    .select()
    .from(sessions)
    .where(eq(sessions.status, "CANCELLED"));
  return rows.map(mapSession);
};

/**
 * Return DECIDED sessions whose `reminder_sent_at <= olderThan` (staleness boundary).
 *
 * @remarks
 * claim-first が立てた `reminder_sent_at` が残る = 送信側が revert 前に crash した可能性。
 * Reconciler がこの集合に対し {@link revertReminderClaim} で戻す。
 * @see ADR-0024, ADR-0033
 */
export const findStaleReminderClaims = async (
  db: DbLike,
  olderThan: Date
): Promise<SessionRow[]> => {
  const rows = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.status, "DECIDED"),
        lte(sessions.reminderSentAt, olderThan)
      )
    );
  return rows.map(mapSession);
};

export const findNonTerminalSessionsByWeekKey = async (
  db: DbLike,
  weekKey: string
): Promise<SessionRow[]> => {
  const rows = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.weekKey, weekKey),
        inArray(sessions.status, [...NON_TERMINAL_STATUSES])
      )
    );
  return rows.map(mapSession);
};
