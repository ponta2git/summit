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
} from "./rows.js";
import type {
  CreateAskSessionInput,
  CancelAskingInput,
  CompleteCancelledSessionInput,
  CompletePostponeVotingInput,
  CompleteSessionInput,
  DecideAskingInput,
  StartPostponeVotingInput
} from "./repositories/sessions.js";
import type { UpsertResponseInput } from "./repositories/responses.js";
import type {
  CompleteDecidedSessionAsHeldInput,
  CompleteDecidedSessionAsHeldResult
} from "./repositories/heldEvents.js";
import type {
  EnqueueOutboxInput,
  EnqueueResult,
  OutboxEntry,
  OutboxPayload,
  OutboxPayloadTarget
} from "./repositories/outbox.js";

export type {
  HeldEventParticipantRow,
  HeldEventRow,
  MemberRow,
  ResponseRow,
  SessionRow,
  SessionStatus,
  CreateAskSessionInput,
  CancelAskingInput,
  CompleteCancelledSessionInput,
  CompletePostponeVotingInput,
  CompleteSessionInput,
  DecideAskingInput,
  StartPostponeVotingInput,
  UpsertResponseInput,
  CompleteDecidedSessionAsHeldInput,
  CompleteDecidedSessionAsHeldResult,
  EnqueueOutboxInput,
  EnqueueResult,
  OutboxEntry,
  OutboxPayload,
  OutboxPayloadTarget
};

export type { ResponseChoice } from "./rows.js";

export interface SchedulerSessionHints {
  readonly nextAskingDeadlineAt: Date | null;
  readonly nextPostponeDeadlineAt: Date | null;
  readonly nextReminderAt: Date | null;
}

export const SESSION_ALLOWED_TRANSITIONS = {
  ASKING: ["CANCELLED", "DECIDED"],
  POSTPONE_VOTING: ["POSTPONED", "COMPLETED"],
  POSTPONED: [],
  DECIDED: ["COMPLETED"],
  CANCELLED: ["POSTPONE_VOTING", "COMPLETED"],
  COMPLETED: [],
  SKIPPED: []
} as const satisfies Readonly<Record<SessionStatus, readonly SessionStatus[]>>;

/**
 * Derive the union of valid next statuses for a given source status `S`.
 *
 * @remarks
 * Indexed access type over `SESSION_ALLOWED_TRANSITIONS`. Enables `runEdgeUpdate` to enforce
 * state machine transitions at compile time without runtime overhead.
 *
 * @example
 * AllowedNextStatus<"ASKING">         // = "CANCELLED" | "DECIDED"
 * AllowedNextStatus<"COMPLETED">      // = never  (terminal state)
 */
export type AllowedNextStatus<S extends SessionStatus> =
  (typeof SESSION_ALLOWED_TRANSITIONS)[S][number];

/**
 * Session repository operations exposed as a DI port.
 *
 * @remarks
 * 各実装は DB を正本とし、競合時に `undefined` を返す CAS 契約を維持する。
 * @see ADR-0001
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
   * Returns `true` on CAS win, `false` if already set (reconciler / retry has populated it).
   * Outbox worker uses this to avoid racing with reconciler repost. Unconditional overwrite
   * must use `updateAskMessageId`.
   * @see ADR-0035
   */
  backfillAskMessageId(id: string, messageId: string): Promise<boolean>;
  /**
   * Back-fill `postpone_message_id` atomically only if currently NULL (CAS-on-NULL).
   *
   * @remarks
   * See {@link SessionsPort.backfillAskMessageId} for rationale.
   */
  backfillPostponeMessageId(id: string, messageId: string): Promise<boolean>;
  cancelAsking(input: CancelAskingInput): Promise<SessionRow | undefined>;
  startPostponeVoting(input: StartPostponeVotingInput): Promise<SessionRow | undefined>;
  completePostponeVoting(input: CompletePostponeVotingInput): Promise<SessionRow | undefined>;
  decideAsking(input: DecideAskingInput): Promise<SessionRow | undefined>;
  completeCancelledSession(input: CompleteCancelledSessionInput): Promise<SessionRow | undefined>;
  completeSession(input: CompleteSessionInput): Promise<SessionRow | undefined>;
  /**
   * Claim the reminder dispatch slot atomically before sending to Discord.
   *
   * @remarks
   * CAS 勝 (status=DECIDED, reminder_sent_at IS NULL) で行を返し、競合敗北時は undefined。
   * @see ADR-0024
   */
  claimReminderDispatch(id: string, now: Date): Promise<SessionRow | undefined>;
  /**
   * Release a reminder claim if the Discord send fails so the next tick can retry.
   *
   * @remarks
   * `(status=DECIDED, reminder_sent_at=claimedAt)` 一致時のみ NULL に戻す。
   */
  revertReminderClaim(id: string, claimedAt: Date): Promise<boolean>;
  findDueAskingSessions(now: Date): Promise<readonly SessionRow[]>;
  findDuePostponeVotingSessions(now: Date): Promise<readonly SessionRow[]>;
  findDueReminderSessions(now: Date): Promise<readonly SessionRow[]>;
  getSchedulerSessionHints(now: Date): Promise<SchedulerSessionHints>;
  /**
   * Returns sessions currently in `CANCELLED` status (startup reconciler target).
   *
   * @remarks
   * `CANCELLED` は短命中間状態 (ADR-0001)。通常時は空。crash 由来の宙づり回収に使う。
   * @see ADR-0033
   */
  findStrandedCancelledSessions(): Promise<readonly SessionRow[]>;
  /**
   * Returns DECIDED sessions whose `reminder_sent_at` is older than `olderThan`.
   *
   * @remarks
   * claim-first で `reminder_sent_at=now` を立てたまま送信 → revert 経路で crash すると stuck する。
   * reconciler が候補検出 → `revertReminderClaim` で戻す。
   * @see ADR-0024, ADR-0033
   */
  findStaleReminderClaims(olderThan: Date): Promise<readonly SessionRow[]>;
  findNonTerminalSessions(): Promise<readonly SessionRow[]>;
  findNonTerminalSessionsByWeekKey(weekKey: string): Promise<readonly SessionRow[]>;
  skipSession(input: { id: string; cancelReason: string }): Promise<SessionRow | undefined>;
  isNonTerminal(status: SessionStatus): boolean;
}

export interface ResponsesPort {
  listResponses(sessionId: string): Promise<readonly ResponseRow[]>;
  upsertResponse(input: UpsertResponseInput): Promise<ResponseRow>;
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
  listParticipants(heldEventId: string): Promise<readonly HeldEventParticipantRow[]>;
}

/**
 * Discord send outbox port.
 *
 * @remarks
 * 状態遷移と Discord 送信を非同期に切り離す at-least-once 配送キュー。
 * `enqueue` は outbox 単独挿入 (tx 非依存経路用)。状態遷移 tx 内で atomic に enqueue したい場合は、
 * Session 系 CAS API の `outbox` フィールドに `EnqueueOutboxInput[]` を渡す (同 tx で insert される)。
 * @see ADR-0035
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
    options: { readonly deliveredMessageId: string | null; readonly now: Date }
  ): Promise<boolean>;
  markFailed(
    id: string,
    options: {
      readonly error: string;
      readonly now: Date;
      readonly nextAttemptAt: Date | null;
    }
  ): Promise<boolean>;
  releaseExpiredClaims(now: Date): Promise<number>;
  findStranded(attemptsThreshold: number): Promise<readonly OutboxEntry[]>;
  prune(options: {
    readonly deliveredOlderThan: Date;
    readonly failedOlderThan: Date;
  }): Promise<{ readonly deliveredPruned: number; readonly failedPruned: number }>;
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
  readonly responses: ResponsesPort;
  readonly members: MembersPort;
  readonly heldEvents: HeldEventsPort;
  readonly outbox: OutboxPort;
}
