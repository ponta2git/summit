// source-of-truth: session 集約ルート。状態遷移・週キー・締切を扱う。
import { and, eq, inArray, isNull, lte, sql } from "drizzle-orm";

import {
  SESSION_STATUSES,
  sessions
} from "../schema.js";
import type {
  DbLike,
  SessionRow,
  SessionStatus
} from "../types.js";


const NON_TERMINAL_STATUSES: readonly SessionStatus[] = [
  "ASKING",
  "POSTPONE_VOTING",
  "POSTPONED",
  "DECIDED",
  "CANCELLED"
];

const assertStatus = (value: string): SessionStatus => {
  if ((SESSION_STATUSES as readonly string[]).includes(value)) {
    return value as SessionStatus;
  }
  throw new Error(`Invalid session status: ${value}`);
};

const mapSession = (row: typeof sessions.$inferSelect): SessionRow => ({
  id: row.id,
  weekKey: row.weekKey,
  postponeCount: row.postponeCount,
  candidateDateIso: row.candidateDateIso,
  status: assertStatus(row.status),
  channelId: row.channelId,
  askMessageId: row.askMessageId,
  postponeMessageId: row.postponeMessageId,
  deadlineAt: row.deadlineAt,
  decidedStartAt: row.decidedStartAt,
  cancelReason: row.cancelReason,
  reminderAt: row.reminderAt,
  reminderSentAt: row.reminderSentAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt
});

export interface CreateAskSessionInput {
  id: string;
  weekKey: string;
  postponeCount: number;
  candidateDateIso: string;
  channelId: string;
  deadlineAt: Date;
}

/**
 * Creates an ASKING session for the given (weekKey, postponeCount).
 *
 * @returns The newly created session, or `undefined` if another process already inserted one
 *   for the same (weekKey, postponeCount) pair (race lost).
 *
 * @remarks
 * `(weekKey, postponeCount)` unique 制約と `onConflictDoNothing` で race を吸収する。
 * 呼び出し側は `undefined` を skipped として扱い、多重送信を回避する。
 */
export const createAskSession = async (
  db: DbLike,
  input: CreateAskSessionInput
): Promise<SessionRow | undefined> => {
  // race: (weekKey, postponeCount) unique 制約と onConflictDoNothing で race 敗者は undefined。
  //   呼び出し側は undefined を「既に別プロセス / 別 tick が作成済み」として skipped 扱いする。
  const rows = await db
    .insert(sessions)
    .values({
      id: input.id,
      weekKey: input.weekKey,
      postponeCount: input.postponeCount,
      candidateDateIso: input.candidateDateIso,
      status: "ASKING",
      channelId: input.channelId,
      deadlineAt: input.deadlineAt
    })
    .onConflictDoNothing({
      target: [sessions.weekKey, sessions.postponeCount]
    })
    .returning();
  const row = rows[0];
  return row ? mapSession(row) : undefined;
};

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

export const updateAskMessageId = async (
  db: DbLike,
  id: string,
  messageId: string
): Promise<void> => {
  await db
    .update(sessions)
    .set({ askMessageId: messageId, updatedAt: sql`now()` })
    .where(eq(sessions.id, id));
};

export const updatePostponeMessageId = async (
  db: DbLike,
  id: string,
  messageId: string
): Promise<void> => {
  await db
    .update(sessions)
    .set({ postponeMessageId: messageId, updatedAt: sql`now()` })
    .where(eq(sessions.id, id));
};

export interface TransitionInput {
  id: string;
  from: SessionStatus;
  to: SessionStatus;
  cancelReason?: string;
  decidedStartAt?: Date;
  reminderAt?: Date;
  reminderSentAt?: Date;
  updatedDeadlineAt?: Date;
}

/**
 * Atomically transitions a session's status using a conditional UPDATE (CAS).
 *
 * @returns The updated session row if the CAS succeeded, or `undefined` if another handler
 *   already transitioned the session first (race lost).
 * @throws Never. Race losses are expressed as `undefined`, not exceptions.
 *
 * @remarks
 * `WHERE status = input.from` を付けた UPDATE 文で、競合時も片方だけが成功する。
 * 呼び出し側は `undefined` を観測したら DB から再取得して最新状態に合わせて処理を続ける。
 * 状態を巻き戻してはならない。
 *
 * @see docs/adr/0001-single-instance-db-as-source-of-truth.md
 */
export const transitionStatus = async (
  db: DbLike,
  input: TransitionInput
): Promise<SessionRow | undefined> => {
  const patch: Partial<typeof sessions.$inferInsert> = {
    status: input.to,
    updatedAt: sql`now()` as unknown as Date
  };
  if (input.cancelReason !== undefined) {patch.cancelReason = input.cancelReason;}
  if (input.decidedStartAt !== undefined) {patch.decidedStartAt = input.decidedStartAt;}
  if (input.reminderAt !== undefined) {patch.reminderAt = input.reminderAt;}
  if (input.reminderSentAt !== undefined) {patch.reminderSentAt = input.reminderSentAt;}
  if (input.updatedDeadlineAt !== undefined) {patch.deadlineAt = input.updatedDeadlineAt;}

  // race: CAS primitive。WHERE status = input.from で現在状態を条件にし、勝者だけが UPDATE 成功する。
  //   undefined が返ったら「別ハンドラが先に遷移させた (race lost)」を意味する。呼び出し側は
  //   状態を巻き戻さず DB 再取得して処理を続ける。
  // @see docs/adr/0001-single-instance-db-as-source-of-truth.md
  const rows = await db
    .update(sessions)
    .set(patch)
    .where(and(eq(sessions.id, input.id), eq(sessions.status, input.from)))
    .returning();
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
  // state: 順延投票の締切判定は `POSTPONE_VOTING` のみ対象。ASKING など他状態は除外する。
  const rows = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.status, "POSTPONE_VOTING"), lte(sessions.deadlineAt, now)));
  return rows.map(mapSession);
};

/**
 * Finds DECIDED sessions whose 15-minute-before reminder is due and not yet sent.
 *
 * @remarks
 * cron (毎分) と起動時リカバリの双方から呼ばれる。`reminder_sent_at IS NULL` を条件に入れることで
 * 再送を防ぐ。スキップ判定で `reminder_sent_at=now` を埋めた Session は自動的に除外される。
 * @see requirements/base.md §5.2, docs/adr/0024-reminder-dispatch.md
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
    .where(inArray(sessions.status, NON_TERMINAL_STATUSES as SessionStatus[]));
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
        inArray(sessions.status, NON_TERMINAL_STATUSES as SessionStatus[])
      )
    );
  return rows.map(mapSession);
};

/**
 * Atomically transitions a non-terminal session to `SKIPPED`.
 *
 * @returns The updated row on success, or `undefined` if the session is already terminal
 *   (COMPLETED / SKIPPED) or does not exist (race lost).
 *
 * @remarks
 * `/cancel_week` 用の CAS プリミティブ。`transitionStatus` と違い from を複数許容するため、
 * `WHERE status IN (non-terminal set)` を一段で評価する。冪等: 既に SKIPPED / COMPLETED の場合は
 * 何もせず undefined。
 * @see docs/adr/0023-cancel-week-command-flow.md
 */
export const skipSession = async (
  db: DbLike,
  input: { id: string; cancelReason: string }
): Promise<SessionRow | undefined> => {
  // race: 任意の非終端状態から SKIPPED への CAS。IN 条件で原子的に狭める。
  //   COMPLETED / SKIPPED に既に遷移していれば undefined を返し、呼び出し側は冪等に扱う。
  const rows = await db
    .update(sessions)
    .set({
      status: "SKIPPED",
      cancelReason: input.cancelReason,
      updatedAt: sql`now()` as unknown as Date
    })
    .where(
      and(
        eq(sessions.id, input.id),
        inArray(sessions.status, NON_TERMINAL_STATUSES as SessionStatus[])
      )
    )
    .returning();
  const row = rows[0];
  return row ? mapSession(row) : undefined;
};

export const isNonTerminal = (status: SessionStatus): boolean =>
  (NON_TERMINAL_STATUSES as readonly string[]).includes(status);
