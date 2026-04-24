// source-of-truth: sessions repository の公開 input 型。
// @see ADR-0038

import type { EnqueueOutboxInput } from "./outbox.js";

export interface CreateAskSessionInput {
  id: string;
  weekKey: string;
  postponeCount: number;
  candidateDateIso: string;
  channelId: string;
  deadlineAt: Date;
}

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
