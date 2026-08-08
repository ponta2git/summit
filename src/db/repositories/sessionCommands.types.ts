import type {
  ResponseChoice,
  ResponseRow,
  SessionRow
} from "../rows.ts";

export type AskResponseChoice = Exclude<
  ResponseChoice,
  "POSTPONE_OK" | "POSTPONE_NG"
>;
export type PostponeResponseChoice = Extract<
  ResponseChoice,
  "POSTPONE_OK" | "POSTPONE_NG"
>;

interface InteractionResponseInput {
  readonly responseId: string;
  readonly sessionId: string;
  readonly memberId: string;
  readonly sourceInteractionId: string;
  readonly now: Date;
  readonly memberCountExpected: number;
}

export interface SubmitAskResponseInput extends InteractionResponseInput {
  readonly choice: AskResponseChoice;
}

export interface SaturdaySessionInput {
  readonly id: string;
  readonly candidateDateIso: string;
  readonly deadlineAt: Date;
}

export interface SubmitPostponeVoteInput extends InteractionResponseInput {
  readonly choice: PostponeResponseChoice;
  readonly saturday: SaturdaySessionInput;
}

export interface SettleDeadlineInput {
  readonly sessionId: string;
  readonly now: Date;
  readonly memberCountExpected: number;
}

export interface SettleAskingCancellationInput {
  readonly sessionId: string;
  readonly now: Date;
  readonly reason: "absent" | "deadline_unanswered" | "saturday_cancelled";
}

export interface SettlePostponeVotingInput extends SettleDeadlineInput {
  readonly saturday: SaturdaySessionInput;
}

export interface CancelWeekInput {
  readonly sentinelSessionId: string;
  readonly weekKey: string;
  readonly candidateDateIso: string;
  readonly channelId: string;
  readonly deadlineAt: Date;
  readonly invokerUserId: string;
  readonly suppressMentions: boolean;
  readonly now: Date;
}

export type CancelWeekResult =
  | {
      readonly kind: "applied" | "already_skipped";
      readonly weekKey: string;
      readonly skippedSessions: readonly SessionRow[];
      readonly sentinelCreated: boolean;
      readonly noticeEnqueued: boolean;
    }
  | {
      readonly kind: "already_held";
      readonly weekKey: string;
      readonly session: SessionRow;
    }
  | {
      readonly kind: "already_closed";
      readonly weekKey: string;
      readonly sessions: readonly SessionRow[];
    };

export type InteractionCommandRejection =
  | { readonly kind: "session_not_found" }
  | { readonly kind: "member_not_found"; readonly session: SessionRow }
  | { readonly kind: "deadline_passed"; readonly session: SessionRow }
  | { readonly kind: "closed"; readonly session: SessionRow }
  | {
      readonly kind: "stale_interaction";
      readonly session: SessionRow;
      readonly response: ResponseRow;
    };

export type SubmitAskResponseResult =
  | InteractionCommandRejection
  | {
      readonly kind: "accepted_pending";
      readonly session: SessionRow;
      readonly response: ResponseRow;
    }
  | {
      readonly kind: "transitioned";
      readonly outcome: "cancelled";
      readonly session: SessionRow;
      readonly response: ResponseRow;
    };

export type AskingDeadlineResult =
  | { readonly kind: "session_not_found" }
  | { readonly kind: "not_due"; readonly session: SessionRow }
  | { readonly kind: "closed"; readonly session: SessionRow }
  | {
      readonly kind: "transitioned";
      readonly outcome: "decided" | "cancelled";
      readonly session: SessionRow;
      readonly responses: readonly ResponseRow[];
    };

export type SettleAskingCancellationResult =
  | { readonly kind: "session_not_found" }
  | { readonly kind: "closed"; readonly session: SessionRow }
  | {
      readonly kind: "transitioned";
      readonly session: SessionRow;
    };

export type PostponeTransitionOutcome =
  | {
      readonly outcome: "all_ok";
      readonly session: SessionRow;
      readonly saturdaySession: SessionRow;
    }
  | {
      readonly outcome: "cancelled";
      readonly session: SessionRow;
    };

export type SubmitPostponeVoteResult =
  | InteractionCommandRejection
  | {
      readonly kind: "accepted_pending";
      readonly session: SessionRow;
      readonly response: ResponseRow;
    }
  | ({
      readonly kind: "transitioned";
      readonly response: ResponseRow;
    } & PostponeTransitionOutcome);

export type SettlePostponeVotingResult =
  | { readonly kind: "session_not_found" }
  | { readonly kind: "not_due"; readonly session: SessionRow }
  | { readonly kind: "closed"; readonly session: SessionRow }
  | ({ readonly kind: "transitioned" } & PostponeTransitionOutcome);
