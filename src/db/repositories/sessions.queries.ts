// source-of-truth: sessions repository のクエリ群。write なし。
// @see ADR-0051

import { and, eq, inArray, lte, sql } from "drizzle-orm";

import { sessions } from "../schema.js";
import { parseDbTimestamp, type DbLike, type SessionRow } from "../rows.js";
import type { SchedulerSessionHints } from "../ports.js";
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
 * Find DECIDED sessions whose reminder is due.
 *
 * @remarks
 * idempotent: scheduler と起動時リカバリ双方から呼ばれるが、outbox dedupe が重複 intent を吸収する。
 *   `reminder_sent_at` は旧 claim-first 経路の途中 marker として残る場合があるため、
 *   DECIDED 行の再配送判定には使わない。新経路では配送完了時に DECIDED→COMPLETED と
 *   同一 transaction で marker を書く。
 * @see requirements/base.md §5.2, ADR-0051
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
        lte(sessions.reminderAt, now)
      )
    );
  return rows.map(mapSession);
};

/**
 * Return the nearest session-driven scheduler wakeups.
 *
 * @remarks
 * source-of-truth: DB state, not in-memory timers. Past timestamps are intentionally returned
 * so the scheduler can immediately settle overdue work after a missed wake or reconnect.
 */
export const getSchedulerSessionHints = async (
  db: DbLike,
  _now: Date
): Promise<SchedulerSessionHints> => {
  const [asking] = await db
    .select({ next: sql<unknown>`min(${sessions.deadlineAt})` })
    .from(sessions)
    .where(eq(sessions.status, "ASKING"));
  const [postpone] = await db
    .select({ next: sql<unknown>`min(${sessions.deadlineAt})` })
    .from(sessions)
    .where(eq(sessions.status, "POSTPONE_VOTING"));
  const [reminder] = await db
    .select({ next: sql<unknown>`min(${sessions.reminderAt})` })
    .from(sessions)
    .where(
      and(
        eq(sessions.status, "DECIDED")
      )
    );

  return {
    nextAskingDeadlineAt: parseDbTimestamp(
      asking?.next ?? null,
      "next asking deadline timestamp"
    ),
    nextPostponeDeadlineAt: parseDbTimestamp(
      postpone?.next ?? null,
      "next postpone deadline timestamp"
    ),
    nextReminderAt: parseDbTimestamp(
      reminder?.next ?? null,
      "next reminder timestamp"
    )
  };
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
 * @see ADR-0051
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
