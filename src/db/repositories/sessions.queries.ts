// source-of-truth: sessions repository のクエリ群。write なし。

import { and, eq, inArray, lte, or, sql } from "drizzle-orm";

import { sessions } from "../schema.ts";
import { parseDbTimestamp, type DbLike, type SessionRow } from "../rows.ts";
import type { SchedulerSessionHints } from "../ports.ts";
import { mapSession, MESSAGE_RECOVERY_STATUSES } from "./sessions.internal.ts";

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
 * @see requirements/base.md §5.2
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
 * Find every session that startup recovery can settle or enqueue.
 *
 * @remarks
 * `reminderSentAt` is a legacy claim marker and is deliberately not a due predicate: a DECIDED
 * row carrying that marker may still have no delivered outbox message. The outbox dedupe key and
 * DECIDED→COMPLETED CAS provide the recovery boundary.
 */
export const findDueStartupRecoverySessions = async (
  db: DbLike,
  now: Date
): Promise<SessionRow[]> => {
  const rows = await db
    .select()
    .from(sessions)
    .where(
      or(
        and(
          inArray(sessions.status, ["ASKING", "POSTPONE_VOTING"]),
          lte(sessions.deadlineAt, now)
        ),
        and(
          eq(sessions.status, "DECIDED"),
          lte(sessions.reminderAt, now)
        )
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
  const [row] = await db
    .select({
      nextAsking: sql<unknown>`min(case when ${sessions.status} = 'ASKING' then ${sessions.deadlineAt} end)`,
      nextPostpone: sql<unknown>`min(case when ${sessions.status} = 'POSTPONE_VOTING' then ${sessions.deadlineAt} end)`,
      nextReminder: sql<unknown>`min(case when ${sessions.status} = 'DECIDED' then ${sessions.reminderAt} end)`
    })
    .from(sessions);

  return {
    nextAskingDeadlineAt: parseDbTimestamp(
      row?.nextAsking ?? null,
      "next asking deadline timestamp"
    ),
    nextPostponeDeadlineAt: parseDbTimestamp(
      row?.nextPostpone ?? null,
      "next postpone deadline timestamp"
    ),
    nextReminderAt: parseDbTimestamp(
      row?.nextReminder ?? null,
      "next reminder timestamp"
    )
  };
};

export const findMessageRecoveryCandidates = async (
  db: DbLike
): Promise<SessionRow[]> => {
  const rows = await db
    .select()
    .from(sessions)
    .where(inArray(sessions.status, [...MESSAGE_RECOVERY_STATUSES]));
  return rows.map(mapSession);
};

/**
 * Return sessions currently in `CANCELLED` status.
 *
 * @remarks
 * `CANCELLED` は短命中間状態。空でなければ crash 由来の宙づり。Startup reconciler から呼ばれる。
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
