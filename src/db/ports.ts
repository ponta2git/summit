// source-of-truth: DB 境界契約。repository 実装はここを `satisfies` し、テストは Fake で満たす。
//   db ハンドルは port 実装が closure で保持し、call-site を db 非依存にする。
//   Discord client は抽象化しない (ADR-0017, ADR-0026)。
// @see ADR-0018

import type {
  HeldEventParticipantRow,
  HeldEventRow,
  MemberRow,
  ResponseRow,
  SessionRow,
  SessionStatus
} from "./rows.ts";
import type {
  CreateAskSessionInput
} from "./repositories/sessions.ts";
import type {
  CompleteDecidedSessionAsHeldInput,
  CompleteDecidedSessionAsHeldResult
} from "./repositories/heldEvents.ts";
import type {
  EnqueueOutboxInput,
  EnqueueResult,
  OutboxEntry,
  OutboxPayload
} from "./repositories/outbox.ts";
import type {
  AskingDeadlineResult,
  CancelWeekInput,
  CancelWeekResult,
  SettleAskingCancellationInput,
  SettleAskingCancellationResult,
  SettleDeadlineInput,
  SettlePostponeVotingInput,
  SettlePostponeVotingResult,
  SubmitAskResponseInput,
  SubmitAskResponseResult,
  SubmitPostponeVoteInput,
  SubmitPostponeVoteResult
} from "./repositories/sessionCommands.ts";

export type {
  HeldEventParticipantRow,
  HeldEventRow,
  MemberRow,
  ResponseRow,
  SessionRow,
  SessionStatus,
  CreateAskSessionInput,
  CompleteDecidedSessionAsHeldInput,
  CompleteDecidedSessionAsHeldResult,
  EnqueueOutboxInput,
  EnqueueResult,
  OutboxEntry,
  OutboxPayload,
  AskingDeadlineResult,
  CancelWeekInput,
  CancelWeekResult,
  SettleAskingCancellationInput,
  SettleAskingCancellationResult,
  SettleDeadlineInput,
  SettlePostponeVotingInput,
  SettlePostponeVotingResult,
  SubmitAskResponseInput,
  SubmitAskResponseResult,
  SubmitPostponeVoteInput,
  SubmitPostponeVoteResult
};

export type { ResponseChoice } from "./rows.ts";

export interface SchedulerSessionHints {
  readonly nextAskingDeadlineAt: Date | null;
  readonly nextPostponeDeadlineAt: Date | null;
  readonly nextReminderAt: Date | null;
}

/**
 * Session repository operations exposed as a DI port.
 *
 * @remarks
 * Read models, initial creation, and Discord message-id maintenance only. Business
 * transitions belong to {@link SessionCommandsPort}, which owns aggregate locking.
 * @see ADR-0001, ADR-0051
 */
export interface SessionsPort {
  createAskSession(input: CreateAskSessionInput): Promise<SessionRow | undefined>;
  findSessionByWeekKeyAndPostponeCount(
    weekKey: string,
    postponeCount: number
  ): Promise<SessionRow | undefined>;
  findSessionById(id: string): Promise<SessionRow | undefined>;
  updateAskMessageId(id: string, messageId: string): Promise<void>;
  updatePostponeMessageId(id: string, messageId: string): Promise<void>;
  /**
   * Back-fill `ask_message_id` atomically only if currently NULL (CAS-on-NULL).
   *
   * @remarks
   * Returns `true` on CAS win, `false` if another delivery or recovery path populated it.
   * An expired claimant and its replacement can both reach Discord, so this elects one
   * canonical message without overwriting it. Intent finalization is fenced separately.
   * @see ADR-0051
   */
  backfillAskMessageId(id: string, messageId: string): Promise<boolean>;
  /**
   * Back-fill `postpone_message_id` atomically only if currently NULL (CAS-on-NULL).
   *
   * @remarks
   * See {@link SessionsPort.backfillAskMessageId} for rationale.
   */
  backfillPostponeMessageId(id: string, messageId: string): Promise<boolean>;
  findDueAskingSessions(now: Date): Promise<readonly SessionRow[]>;
  findDuePostponeVotingSessions(now: Date): Promise<readonly SessionRow[]>;
  findDueReminderSessions(now: Date): Promise<readonly SessionRow[]>;
  getSchedulerSessionHints(now: Date): Promise<SchedulerSessionHints>;
  /**
   * Returns sessions currently in `CANCELLED` status (startup reconciler target).
   *
   * @remarks
   * `CANCELLED` は短命中間状態 (ADR-0001)。通常時は空。crash 由来の宙づり回収に使う。
   * @see ADR-0051
   */
  findStrandedCancelledSessions(): Promise<readonly SessionRow[]>;
  findNonTerminalSessions(): Promise<readonly SessionRow[]>;
}

export interface ResponsesPort {
  listResponses(sessionId: string): Promise<readonly ResponseRow[]>;
}

/**
 * Session aggregate commands.
 *
 * @remarks
 * Every implementation locks the Session first, then evaluates Response mutations and
 * state transitions against one snapshot. Interaction handlers must use these methods
 * instead of composing ResponsesPort + SessionsPort writes.
 */
export interface SessionCommandsPort {
  cancelWeekAtomically(input: CancelWeekInput): Promise<CancelWeekResult>;
  submitAskResponse(input: SubmitAskResponseInput): Promise<SubmitAskResponseResult>;
  settleAskingCancellation(
    input: SettleAskingCancellationInput
  ): Promise<SettleAskingCancellationResult>;
  settleAskingDeadline(input: SettleDeadlineInput): Promise<AskingDeadlineResult>;
  submitPostponeVote(input: SubmitPostponeVoteInput): Promise<SubmitPostponeVoteResult>;
  settlePostponeVoting(
    input: SettlePostponeVotingInput
  ): Promise<SettlePostponeVotingResult>;
}

export interface MembersPort {
  findMemberIdByUserId(userId: string): Promise<string | undefined>;
  listMembers(): Promise<readonly MemberRow[]>;
}

/**
 * HeldEvent persistence port.
 *
 * @remarks
 * §8.3 の実開催履歴を扱う。中止回 (§8.4) では作成しないため、唯一の作成経路は
 * `completeDecidedSessionAsHeld` (DECIDED→COMPLETED CAS と同一 tx)。
 * @see ADR-0031
 */
export interface HeldEventsPort {
  completeDecidedSessionAsHeld(
    input: CompleteDecidedSessionAsHeldInput
  ): Promise<CompleteDecidedSessionAsHeldResult | undefined>;
  findBySessionId(sessionId: string): Promise<HeldEventRow | undefined>;
}

/**
 * Discord send outbox port.
 *
 * @remarks
 * 状態遷移と Discord 送信を非同期に切り離す at-least-once 配送キュー。
 * `enqueue` は recovery などの単独 intent 用。業務遷移は SessionCommandsPort、初回募集は
 * createAskSession が同一 transaction で intent を永続化する。Session 内順序は
 * aggregateRevision / ordinal、claim 所有権は claimToken で fence する。
 * @see ADR-0051
 */
export interface OutboxPort {
  enqueue(input: EnqueueOutboxInput): Promise<EnqueueResult>;
  claimNextBatch(options: {
    readonly limit: number;
    readonly now: Date;
    readonly claimDurationMs: number;
  }): Promise<readonly OutboxEntry[]>;
  markDelivered(
    id: string,
    options: {
      readonly claimToken: string;
      readonly deliveredMessageId: string | null;
      readonly now: Date;
    }
  ): Promise<boolean>;
  markFailed(
    id: string,
    options: {
      readonly error: string;
      readonly claimToken: string;
      readonly now: Date;
      readonly nextAttemptAt: Date | null;
    }
  ): Promise<boolean>;
  requeueFailedChains(now: Date): Promise<{
    readonly deadLettersRequeued: number;
    readonly successorsRequeued: number;
  }>;
  releaseExpiredClaims(now: Date): Promise<number>;
  findStranded(attemptsThreshold: number): Promise<readonly OutboxEntry[]>;
  prune(options: {
    readonly deliveredOlderThan: Date;
    readonly failedOlderThan: Date;
  }): Promise<{
    readonly deliveredPruned: number;
    readonly failedPruned: number;
    readonly cancelledPruned: number;
  }>;
  getMetrics(now: Date): Promise<{
    readonly pending: number;
    readonly inFlight: number;
    readonly failed: number;
    readonly oldestPendingAgeMs: number | null;
    readonly oldestFailedAgeMs: number | null;
  }>;
  getNextDispatchAt(now: Date): Promise<Date | null>;
}

/**
 * Aggregate port bundle supplied to handlers / scheduler / workflow via AppContext.
 *
 * @remarks
 * Discord client は抽象化しない (ADR-0017)。discord.js の Client / ButtonInteraction を
 * 直接扱う方がシンプルで、追加抽象は便益を生まない。
 */
export interface AppPorts {
  readonly sessions: SessionsPort;
  readonly sessionCommands: SessionCommandsPort;
  readonly responses: ResponsesPort;
  readonly members: MembersPort;
  readonly heldEvents: HeldEventsPort;
  readonly outbox: OutboxPort;
}
