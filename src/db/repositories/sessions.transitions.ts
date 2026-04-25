// source-of-truth: sessions repository の状態遷移（CAS）。
// @see ADR-0038

import { and, eq, inArray, sql } from "drizzle-orm";

import { sessions } from "../schema.js";
import type { DbLike, SessionRow } from "../rows.js";
import {
  NON_TERMINAL_STATUSES,
  mapSession,
  runEdgeUpdate
} from "./sessions.internal.js";
import type {
  CancelAskingInput,
  CompleteCancelledSessionInput,
  CompletePostponeVotingInput,
  CompleteSessionInput,
  DecideAskingInput,
  StartPostponeVotingInput
} from "./sessions.types.js";

/**
 * Transition ASKING → CANCELLED via CAS.
 *
 * @remarks
 * race: status が既に ASKING でなければ undefined。呼び出し側は DB 最新状態を正本として続行する。
 */
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
    outbox: input.outbox
  });
/**
 * Transition CANCELLED → POSTPONE_VOTING via CAS.
 *
 * @remarks
 * race: 金曜中止後の順延投票開始だけを許可する。競合敗北時は undefined。
 */
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
      updatedAt: input.now
    },
    outbox: input.outbox
  });
/**
 * Transition POSTPONE_VOTING to its terminal outcome via CAS.
 *
 * @remarks
 * state: 全員 OK は POSTPONED、NG/未回答は COMPLETED。競合敗北時は undefined。
 */
export const completePostponeVoting = async (
  db: DbLike,
  input: CompletePostponeVotingInput
): Promise<SessionRow | undefined> => {
  if (input.outcome === "decided") {
    return runEdgeUpdate(db, {
      id: input.id,
      from: "POSTPONE_VOTING",
      patch: { status: "POSTPONED", updatedAt: input.now },
      outbox: input.outbox
    });
  }
  return runEdgeUpdate(db, {
    id: input.id,
    from: "POSTPONE_VOTING",
    patch: { status: "COMPLETED", cancelReason: input.cancelReason, updatedAt: input.now },
    outbox: input.outbox
  });
};
/**
 * Transition ASKING → DECIDED via CAS.
 *
 * @remarks
 * state: decidedStartAt と reminderAt を同じ DB edge で確定する。競合敗北時は undefined。
 */
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
    outbox: input.outbox
  });
/**
 * Transition CANCELLED → COMPLETED via CAS.
 *
 * @remarks
 * state: 土曜回中止や順延 NG の短命 CANCELLED を終端へ収束させる。競合敗北時は undefined。
 */
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
    outbox: input.outbox
  });
/**
 * Transition DECIDED → COMPLETED via CAS.
 *
 * @remarks
 * state: reminderSentAt を記録して開催済み終端へ進める。競合敗北時は undefined。
 */
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
    },
    outbox: undefined
  });

/**
 * Atomically transition a non-terminal session to `SKIPPED` (`/cancel_week` primitive).
 *
 * @remarks
 * `transitionStatus` と違い from を複数許容するため `WHERE status IN (non-terminal)` を一段で評価する。
 * idempotent: 既に SKIPPED / COMPLETED なら何もせず undefined。
 * @see ADR-0023
 */
export const skipSession = async (
  db: DbLike,
  input: { id: string; cancelReason: string }
): Promise<SessionRow | undefined> => {
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
        inArray(sessions.status, [...NON_TERMINAL_STATUSES])
      )
    )
    .returning();
  const row = rows[0];
  return row ? mapSession(row) : undefined;
};
