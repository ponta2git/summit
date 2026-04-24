import { MessageFlags } from "discord.js";

import type { SessionRow } from "../../db/rows.js";
import { env } from "../../env.js";
import {
  InvariantViolationError,
  NotFoundError,
  ValidationError,
  errResult,
  okResult,
  type AppError,
  type AppResult
} from "../../errors/index.js";
import {
  parseCancelWeekCustomId,
  parseCustomId,
  type AskCustomIdChoice,
  type CancelWeekCustomIdChoice,
  type PostponeCustomIdChoice
} from "./customId.js";

export const assertGuildAndChannel = (
  guildId: string | null,
  channelId: string | null
): boolean =>
  guildId === env.DISCORD_GUILD_ID &&
  channelId === env.DISCORD_CHANNEL_ID;

export const assertMember = (userId: string): boolean =>
  env.MEMBER_USER_IDS.includes(userId);

export const buildEphemeralReject = (content: string) => ({
  content,
  flags: MessageFlags.Ephemeral
} as const);

export const GUARD_FAILURE_REASONS = [
  "wrong_guild",
  "wrong_channel",
  "not_member",
  "invalid_custom_id",
  "session_not_found",
  "session_not_asking",
  "session_asking_closed",
  "session_not_postpone_voting",
  "session_postpone_closed",
  "member_not_registered"
] as const;

export type GuardFailureReason = (typeof GUARD_FAILURE_REASONS)[number];

const isGuardFailureReason = (value: unknown): value is GuardFailureReason =>
  typeof value === "string" &&
  (GUARD_FAILURE_REASONS as ReadonlyArray<string>).includes(value);

const buildGuardCause = (reason: GuardFailureReason) => ({ reason });

const buildValidationError = (reason: GuardFailureReason, message: string): ValidationError =>
  new ValidationError(message, { cause: buildGuardCause(reason) });

export const guardGuildId = (guildId: string | null): AppResult<string, ValidationError> => {
  if (guildId !== env.DISCORD_GUILD_ID) {
    return errResult(buildValidationError("wrong_guild", "Guild is out of scope."));
  }

  return okResult(guildId);
};

export const guardChannelId = (channelId: string | null): AppResult<string, ValidationError> => {
  if (channelId !== env.DISCORD_CHANNEL_ID) {
    return errResult(buildValidationError("wrong_channel", "Channel is out of scope."));
  }

  return okResult(channelId);
};

export const guardMemberUserId = (userId: string): AppResult<string, ValidationError> => {
  if (!env.MEMBER_USER_IDS.includes(userId)) {
    return errResult(buildValidationError("not_member", "User is not an in-scope member."));
  }

  return okResult(userId);
};

export interface AskCustomIdGuardResult {
  readonly sessionId: string;
  readonly choice: AskCustomIdChoice;
}

export const guardAskCustomId = (customId: string): AppResult<AskCustomIdGuardResult, ValidationError> => {
  const parsed = parseCustomId(customId);
  if (!parsed.success || parsed.data.kind !== "ask") {
    return errResult(buildValidationError("invalid_custom_id", "Invalid ask button custom_id."));
  }

  return okResult({
    sessionId: parsed.data.sessionId,
    choice: parsed.data.choice
  });
};

export interface PostponeCustomIdGuardResult {
  readonly sessionId: string;
  readonly choice: PostponeCustomIdChoice;
}

export const guardPostponeCustomId = (
  customId: string
): AppResult<PostponeCustomIdGuardResult, ValidationError> => {
  const parsed = parseCustomId(customId);
  if (!parsed.success || parsed.data.kind !== "postpone") {
    return errResult(buildValidationError("invalid_custom_id", "Invalid postpone button custom_id."));
  }

  return okResult({
    sessionId: parsed.data.sessionId,
    choice: parsed.data.choice
  });
};

export interface CancelWeekCustomIdGuardResult {
  readonly choice: CancelWeekCustomIdChoice;
}

export const guardCancelWeekCustomId = (
  customId: string
): AppResult<CancelWeekCustomIdGuardResult, ValidationError> => {
  const parsed = parseCancelWeekCustomId(customId);
  if (!parsed.success) {
    return errResult(buildValidationError("invalid_custom_id", "Invalid cancel_week custom_id."));
  }

  return okResult({ choice: parsed.data.choice });
};

export const guardSessionExists = (
  session: SessionRow | undefined
): AppResult<SessionRow, NotFoundError> => {
  if (!session) {
    return errResult(
      new NotFoundError("Session not found.", {
        cause: buildGuardCause("session_not_found")
      })
    );
  }

  return okResult(session);
};

export const guardSessionAsking = (
  session: SessionRow
): AppResult<SessionRow, ValidationError> => {
  if (session.status !== "ASKING") {
    return errResult(
      buildValidationError("session_not_asking", "Session is not accepting ask responses.")
    );
  }

  return okResult(session);
};

export const guardSessionPostponeVoting = (
  session: SessionRow
): AppResult<SessionRow, ValidationError> => {
  if (session.status !== "POSTPONE_VOTING") {
    return errResult(
      buildValidationError(
        "session_not_postpone_voting",
        "Session is not accepting postpone responses."
      )
    );
  }

  return okResult(session);
};

export const guardSessionAskingDeadlineOpen = (
  session: SessionRow,
  now: Date
): AppResult<SessionRow, ValidationError> => {
  if (now.getTime() >= session.deadlineAt.getTime()) {
    return errResult(
      buildValidationError("session_asking_closed", "Ask response deadline has passed.")
    );
  }

  return okResult(session);
};

export const guardSessionPostponeDeadlineOpen = (
  session: SessionRow,
  now: Date
): AppResult<SessionRow, ValidationError> => {
  if (now.getTime() >= session.deadlineAt.getTime()) {
    return errResult(
      buildValidationError("session_postpone_closed", "Postpone voting deadline has passed.")
    );
  }

  return okResult(session);
};

export const guardRegisteredMemberId = (
  memberId: string | undefined
): AppResult<string, InvariantViolationError> => {
  if (!memberId) {
    return errResult(
      new InvariantViolationError("Allowed user has no matching member row.", {
        cause: buildGuardCause("member_not_registered")
      })
    );
  }

  return okResult(memberId);
};

export const getGuardFailureReason = (error: AppError): GuardFailureReason | undefined => {
  const cause = error.cause;
  if (typeof cause !== "object" || cause === null) {
    return undefined;
  }

  const reason = "reason" in cause ? cause.reason : undefined;
  return isGuardFailureReason(reason) ? reason : undefined;
};

export { GUARD_REASON_TO_MESSAGE } from "./guards.messages.js";

export const cheapFirstGuard = (
  guildId: string | null,
  channelId: string | null,
  userId: string
): GuardFailureReason | undefined => {
  if (guildId !== env.DISCORD_GUILD_ID) {
    return "wrong_guild";
  }
  if (channelId !== env.DISCORD_CHANNEL_ID) {
    return "wrong_channel";
  }
  if (!env.MEMBER_USER_IDS.includes(userId)) {
    return "not_member";
  }
  return undefined;
};
