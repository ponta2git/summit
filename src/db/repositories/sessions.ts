// source-of-truth: session 集約ルート。状態遷移・週キー・締切を扱う。
import { and, eq, inArray, isNull, lte, sql } from "drizzle-orm";

import {
  SESSION_STATUSES,
  discordOutbox,
  sessions
} from "../schema.js";
import type {
  DbLike,
  SessionRow,
  SessionStatus
} from "../rows.js";
import type { EnqueueOutboxInput } from "./outbox.js";


const NON_TERMINAL_STATUSES: readonly SessionStatus[] = [
  "ASKING",
  "POSTPONE_VOTING",
  "POSTPONED",
  "DECIDED"
];

const assertNever = (value: never): never => {
  throw new Error(`Unexpected value: ${String(value)}`);
};

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

export interface CancelAskingInput {
  readonly id: string;
  readonly now: Date;
  readonly reason: "absent" | "deadline_unanswered" | "saturday_cancelled";
  /** Outbox rows to insert atomically with the CAS. */
  readonly outbox?: readonly EnqueueOutboxInput[];
}

export interface StartPostponeVotingInput {
  readonly id: string;
  readonly now: Date;
  readonly postponeDeadlineAt: Date;
  readonly messageIdPlaceholder?: string;
  readonly outbox?: readonly EnqueueOutboxInput[];
}

export type CompletePostponeVotingInput =
  | {
      readonly id: string;
      readonly now: Date;
      readonly outcome: "decided";
      readonly outbox?: readonly EnqueueOutboxInput[];
    }
  | {
      readonly id: string;
      readonly now: Date;
      readonly outcome: "cancelled_full";
      readonly cancelReason: "postpone_ng" | "postpone_unanswered";
      readonly outbox?: readonly EnqueueOutboxInput[];
    };

export interface DecideAskingInput {
  readonly id: string;
  readonly now: Date;
  readonly decidedStartAt: Date;
  readonly reminderAt: Date;
  readonly outbox?: readonly EnqueueOutboxInput[];
}

export interface CompleteCancelledSessionInput {
  readonly id: string;
  readonly now: Date;
  readonly outbox?: readonly EnqueueOutboxInput[];
}

export interface CompleteSessionInput {
  readonly id: string;
  readonly now: Date;
  readonly reminderSentAt: Date;
  readonly outbox?: readonly EnqueueOutboxInput[];
}

const runEdgeUpdate = async (
  db: DbLike,
  input: {
    readonly id: string;
    readonly from: SessionStatus;
    readonly patch: Partial<typeof sessions.$inferInsert>;
    readonly outbox?: readonly EnqueueOutboxInput[];
  }
): Promise<SessionRow | undefined> =>
  db.transaction(async (tx) => {
    const rows = await tx
      .update(sessions)
      .set(input.patch)
      .where(and(eq(sessions.id, input.id), eq(sessions.status, input.from)))
      .returning();
    const row = rows[0];
    if (!row) {return undefined;}
    // tx: CAS 成功時のみ outbox を enqueue し、状態遷移と送信 intent を atomic にする。
    //   `onConflictDoNothing(dedupeKey)` で同一 intent の再 enqueue は no-op。
    // @see docs/adr/0035-discord-send-outbox.md
    if (input.outbox && input.outbox.length > 0) {
      for (const entry of input.outbox) {
        await tx
          .insert(discordOutbox)
          .values({
            id: crypto.randomUUID(),
            kind: entry.kind,
            sessionId: entry.sessionId,
            payload: entry.payload,
            dedupeKey: entry.dedupeKey
          })
          .onConflictDoNothing({ target: discordOutbox.dedupeKey });
      }
    }
    return mapSession(row);
  });

export const cancelAsking = async (
  db: DbLike,
  input: CancelAskingInput
): Promise<SessionRow | undefined> =>
  runEdgeUpdate(db, {
    id: input.id,
    from: "ASKING",
    patch: {
      status: "CANCELLED",
      cancelReason: input.reason,
      updatedAt: input.now
    },
    ...(input.outbox !== undefined ? { outbox: input.outbox } : {})
  });

export const startPostponeVoting = async (
  db: DbLike,
  input: StartPostponeVotingInput
): Promise<SessionRow | undefined> =>
  runEdgeUpdate(db, {
    id: input.id,
    from: "CANCELLED",
    patch: {
      status: "POSTPONE_VOTING",
      deadlineAt: input.postponeDeadlineAt,
      ...(input.messageIdPlaceholder !== undefined
        ? { postponeMessageId: input.messageIdPlaceholder }
        : {}),
      updatedAt: input.now
    },
    ...(input.outbox !== undefined ? { outbox: input.outbox } : {})
  });

export const completePostponeVoting = async (
  db: DbLike,
  input: CompletePostponeVotingInput
): Promise<SessionRow | undefined> => {
  if (input.outcome === "decided") {
    return runEdgeUpdate(db, {
      id: input.id,
      from: "POSTPONE_VOTING",
      patch: {
        status: "POSTPONED",
        updatedAt: input.now
      },
      ...(input.outbox !== undefined ? { outbox: input.outbox } : {})
    });
  }
  return runEdgeUpdate(db, {
    id: input.id,
    from: "POSTPONE_VOTING",
    patch: {
      status: "COMPLETED",
      cancelReason: input.cancelReason,
      updatedAt: input.now
    },
    ...(input.outbox !== undefined ? { outbox: input.outbox } : {})
  });
};

export const decideAsking = async (
  db: DbLike,
  input: DecideAskingInput
): Promise<SessionRow | undefined> =>
  runEdgeUpdate(db, {
    id: input.id,
    from: "ASKING",
    patch: {
      status: "DECIDED",
      decidedStartAt: input.decidedStartAt,
      reminderAt: input.reminderAt,
      updatedAt: input.now
    },
    ...(input.outbox !== undefined ? { outbox: input.outbox } : {})
  });

export const completeCancelledSession = async (
  db: DbLike,
  input: CompleteCancelledSessionInput
): Promise<SessionRow | undefined> =>
  runEdgeUpdate(db, {
    id: input.id,
    from: "CANCELLED",
    patch: {
      status: "COMPLETED",
      updatedAt: input.now
    },
    ...(input.outbox !== undefined ? { outbox: input.outbox } : {})
  });

export const completeSession = async (
  db: DbLike,
  input: CompleteSessionInput
): Promise<SessionRow | undefined> =>
  runEdgeUpdate(db, {
    id: input.id,
    from: "DECIDED",
    patch: {
      status: "COMPLETED",
      reminderSentAt: input.reminderSentAt,
      updatedAt: input.now
    }
  });

/**
 * Atomically claim the reminder dispatch slot for a DECIDED session.
 *
 * @returns The updated session on CAS win, or `undefined` if the session is no longer DECIDED
 *   or `reminder_sent_at` was already set by a concurrent caller (race lost).
 *
 * @remarks
 * race: claim-first プリミティブ。Discord 送信の**前に**実行することで、同時並行パス
 *   (cron tick と起動時 recovery の重複) が同じ reminder を二重送信するのを防ぐ。
 * idempotent: `reminder_sent_at IS NULL` を条件に含むため、2 度目以降の呼び出しは必ず
 *   undefined を返す (勝者は先着 1 件のみ)。
 * 失敗経路: Discord 送信が throw したら `revertReminderClaim` で `reminder_sent_at=NULL` に
 *   戻し、次 tick で再試行可能にする (at-least-once semantics)。
 * @see docs/adr/0024-reminder-dispatch.md
 */
export const claimReminderDispatch = async (
  db: DbLike,
  id: string,
  now: Date
): Promise<SessionRow | undefined> => {
  const rows = await db
    .update(sessions)
    .set({
      reminderSentAt: now,
      updatedAt: sql`now()` as unknown as Date
    })
    .where(
      and(
        eq(sessions.id, id),
        eq(sessions.status, "DECIDED"),
        isNull(sessions.reminderSentAt)
      )
    )
    .returning();
  const row = rows[0];
  return row ? mapSession(row) : undefined;
};

/**
 * Undo a reminder claim made by {@link claimReminderDispatch} when the Discord send fails.
 *
 * @returns `true` if the claim was reverted, `false` if the row moved on (e.g. completed by
 *   another path or claimed again with a different timestamp).
 *
 * @remarks
 * race: revert 自体も CAS にして `(status=DECIDED, reminder_sent_at=claimedAt)` 一致時のみ
 *   NULL に戻す。これにより、「revert を発行している間に別経路が COMPLETED に遷移させた」
 *   ケースで誤ってリマインドを NULL 化しない。
 * 前提: 呼び出し側は直前に `claimReminderDispatch` で得た `claimedAt` (= `now`) を渡す。
 */
export const revertReminderClaim = async (
  db: DbLike,
  id: string,
  claimedAt: Date
): Promise<boolean> => {
  const rows = await db
    .update(sessions)
    .set({
      reminderSentAt: null,
      updatedAt: sql`now()` as unknown as Date
    })
    .where(
      and(
        eq(sessions.id, id),
        eq(sessions.status, "DECIDED"),
        eq(sessions.reminderSentAt, claimedAt)
      )
    )
    .returning({ id: sessions.id });
  return rows.length > 0;
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

/**
 * Returns sessions currently in `CANCELLED` status.
 *
 * @remarks
 * `CANCELLED` は短命中間状態 (ADR-0001)。本メソッドの結果が空でない場合、crash で遷移が止まっている
 * 宙づり状態と解釈する。Startup reconciler から呼ばれる。
 * @see docs/adr/0033-startup-invariant-reconciler.md
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
 * Returns DECIDED sessions whose `reminder_sent_at <= olderThan`.
 *
 * @remarks
 * claim-first が立てた `reminder_sent_at` が staleness 閾値を超えて残っている場合、送信プロセスが
 * revert 前に crash した可能性が高い。Reconciler はこの集合に対し `revertReminderClaim` で戻す。
 * @see docs/adr/0024-reminder-dispatch.md, docs/adr/0033-startup-invariant-reconciler.md
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

export const isNonTerminal = (status: SessionStatus): boolean => {
  // state: 非終端は startup recovery と /cancel_week 対象。CANCELLED は短命中間状態のため除外。
  // @see docs/adr/0001-single-instance-db-as-source-of-truth.md
  switch (status) {
    case "ASKING":
    case "POSTPONE_VOTING":
    case "POSTPONED":
    case "DECIDED":
      return true;
    case "CANCELLED":
    case "COMPLETED":
    case "SKIPPED":
      return false;
    default:
      return assertNever(status);
  }
};
