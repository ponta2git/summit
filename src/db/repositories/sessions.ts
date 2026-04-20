// source-of-truth: session 集約ルート。状態遷移・週キー・締切を扱う。
import { and, eq, inArray, lte, sql } from "drizzle-orm";

import {
  SESSION_STATUSES,
  sessions
} from "../schema.js";
import type {
  DbLike,
  SessionRow,
  SessionStatus
} from "../types.js";
import type { SessionsPort } from "../../ports/index.js";

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
  const patch: Record<string, unknown> = {
    status: input.to,
    updatedAt: sql`now()`
  };
  if (input.cancelReason !== undefined) {patch.cancelReason = input.cancelReason;}
  if (input.decidedStartAt !== undefined) {patch.decidedStartAt = input.decidedStartAt;}
  if (input.reminderAt !== undefined) {patch.reminderAt = input.reminderAt;}

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

export const findNonTerminalSessions = async (
  db: DbLike
): Promise<SessionRow[]> => {
  const rows = await db
    .select()
    .from(sessions)
    .where(inArray(sessions.status, NON_TERMINAL_STATUSES as SessionStatus[]));
  return rows.map(mapSession);
};

export const isNonTerminal = (status: SessionStatus): boolean =>
  (NON_TERMINAL_STATUSES as readonly string[]).includes(status);


// why: repository 実装が port 契約を満たすことをコンパイル時に固定する。
// invariant: DI 未導入段階でも公開 API の破壊的変更を型検査で即検知する。
const _typecheckSessionsPort = {
  createAskSession,
  findSessionByWeekKeyAndPostponeCount,
  findSessionById,
  updateAskMessageId,
  updatePostponeMessageId,
  transitionStatus,
  findDueAskingSessions,
  findNonTerminalSessions,
  isNonTerminal
} satisfies SessionsPort<DbLike, SessionRow>;
void _typecheckSessionsPort;
