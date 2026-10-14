import * as Result from "effect/Result";
import { MessageFlags } from "discord.js";

import type { SessionRow } from "../../db/rows.ts";
import { appConfig } from "../../userConfig.ts";
import {
  InvariantViolationError,
  NotFoundError,
  ValidationError,
  type AppError
} from "../../errors/index.ts";
import {
  parseCancelWeekCustomId,
  parseAbsentConfirmCustomId,
  parsePostponeNgConfirmCustomId,
  parseCustomId,
  type AbsentConfirmCustomIdChoice,
  type AskCustomIdChoice,
  type CancelWeekCustomIdChoice,
  type PostponeCustomIdChoice,
  type PostponeNgConfirmCustomIdChoice
} from "./customId.ts";

export const buildEphemeralReject = (content: string) => ({
  content,
  flags: MessageFlags.Ephemeral
} as const);

const GUARD_FAILURE_REASONS = [
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

export const guardGuildId = (guildId: string | null): Result.Result<string, ValidationError> => {
  if (guildId !== appConfig.discord.guildId) {
    return Result.fail(buildValidationError("wrong_guild", "Guild is out of scope."));
  }

  return Result.succeed(guildId);
};

export const guardChannelId = (channelId: string | null): Result.Result<string, ValidationError> => {
  if (channelId !== appConfig.discord.channelId) {
    return Result.fail(buildValidationError("wrong_channel", "Channel is out of scope."));
  }

  return Result.succeed(channelId);
};

export const guardMemberUserId = (userId: string): Result.Result<string, ValidationError> => {
  if (!appConfig.memberUserIds.includes(userId)) {
    return Result.fail(buildValidationError("not_member", "User is not an in-scope member."));
  }

  return Result.succeed(userId);
};

interface AskCustomIdGuardResult {
  readonly sessionId: string;
  readonly choice: AskCustomIdChoice;
}

export const guardAskCustomId = (customId: string): Result.Result<AskCustomIdGuardResult, ValidationError> => {
  const parsed = parseCustomId(customId);
  if (!parsed.success || parsed.data.kind !== "ask") {
    return Result.fail(buildValidationError("invalid_custom_id", "Invalid ask button custom_id."));
  }

  return Result.succeed({
    sessionId: parsed.data.sessionId,
    choice: parsed.data.choice
  });
};

interface PostponeCustomIdGuardResult {
  readonly sessionId: string;
  readonly choice: PostponeCustomIdChoice;
}

export const guardPostponeCustomId = (
  customId: string
): Result.Result<PostponeCustomIdGuardResult, ValidationError> => {
  const parsed = parseCustomId(customId);
  if (!parsed.success || parsed.data.kind !== "postpone") {
    return Result.fail(buildValidationError("invalid_custom_id", "Invalid postpone button custom_id."));
  }

  return Result.succeed({
    sessionId: parsed.data.sessionId,
    choice: parsed.data.choice
  });
};

interface CancelWeekCustomIdGuardResult {
  readonly weekKey: string;
  readonly choice: CancelWeekCustomIdChoice;
}

export const guardCancelWeekCustomId = (
  customId: string
): Result.Result<CancelWeekCustomIdGuardResult, ValidationError> => {
  const parsed = parseCancelWeekCustomId(customId);
  if (!parsed.success) {
    return Result.fail(buildValidationError("invalid_custom_id", "Invalid cancel_week custom_id."));
  }

  return Result.succeed({ weekKey: parsed.data.weekKey, choice: parsed.data.choice });
};

interface AbsentConfirmCustomIdGuardResult {
  readonly sessionId: string;
  readonly choice: AbsentConfirmCustomIdChoice;
}

export const guardAbsentConfirmCustomId = (
  customId: string
): Result.Result<AbsentConfirmCustomIdGuardResult, ValidationError> => {
  const parsed = parseAbsentConfirmCustomId(customId);
  if (!parsed.success) {
    return Result.fail(buildValidationError("invalid_custom_id", "Invalid ask_absent custom_id."));
  }

  return Result.succeed({ sessionId: parsed.data.sessionId, choice: parsed.data.choice });
};

interface PostponeNgConfirmCustomIdGuardResult {
  readonly sessionId: string;
  readonly choice: PostponeNgConfirmCustomIdChoice;
}

export const guardPostponeNgConfirmCustomId = (
  customId: string
): Result.Result<PostponeNgConfirmCustomIdGuardResult, ValidationError> => {
  const parsed = parsePostponeNgConfirmCustomId(customId);
  if (!parsed.success) {
    return Result.fail(buildValidationError("invalid_custom_id", "Invalid postpone_ng custom_id."));
  }

  return Result.succeed({ sessionId: parsed.data.sessionId, choice: parsed.data.choice });
};

export const guardSessionExists = (
  session: SessionRow | undefined
): Result.Result<SessionRow, NotFoundError> => {
  if (!session) {
    return Result.fail(
      new NotFoundError("Session not found.", {
        cause: buildGuardCause("session_not_found")
      })
    );
  }

  return Result.succeed(session);
};

export const guardSessionAsking = (
  session: SessionRow
): Result.Result<SessionRow, ValidationError> => {
  if (session.status !== "ASKING") {
    return Result.fail(
      buildValidationError("session_not_asking", "Session is not accepting ask responses.")
    );
  }

  return Result.succeed(session);
};

export const guardSessionPostponeVoting = (
  session: SessionRow
): Result.Result<SessionRow, ValidationError> => {
  if (session.status !== "POSTPONE_VOTING") {
    return Result.fail(
      buildValidationError(
        "session_not_postpone_voting",
        "Session is not accepting postpone responses."
      )
    );
  }

  return Result.succeed(session);
};

export const guardSessionAskingDeadlineOpen = (
  session: SessionRow,
  now: Date
): Result.Result<SessionRow, ValidationError> => {
  if (now.getTime() >= session.deadlineAt.getTime()) {
    return Result.fail(
      buildValidationError("session_asking_closed", "Ask response deadline has passed.")
    );
  }

  return Result.succeed(session);
};

export const guardSessionPostponeDeadlineOpen = (
  session: SessionRow,
  now: Date
): Result.Result<SessionRow, ValidationError> => {
  if (now.getTime() >= session.deadlineAt.getTime()) {
    return Result.fail(
      buildValidationError("session_postpone_closed", "Postpone voting deadline has passed.")
    );
  }

  return Result.succeed(session);
};

export const guardRegisteredMemberId = (
  memberId: string | undefined
): Result.Result<string, InvariantViolationError> => {
  if (!memberId) {
    return Result.fail(
      new InvariantViolationError("Allowed user has no matching member row.", {
        cause: buildGuardCause("member_not_registered")
      })
    );
  }

  return Result.succeed(memberId);
};

export const getGuardFailureReason = (error: AppError): GuardFailureReason | undefined => {
  const cause = error.cause;
  if (typeof cause !== "object" || cause === null) {
    return undefined;
  }

  const reason = "reason" in cause ? cause.reason : undefined;
  return isGuardFailureReason(reason) ? reason : undefined;
};

export { GUARD_REASON_TO_MESSAGE } from "./guards.messages.ts";

export const cheapFirstGuard = (
  guildId: string | null,
  channelId: string | null,
  userId: string
): GuardFailureReason | undefined => {
  if (guildId !== appConfig.discord.guildId) {
    return "wrong_guild";
  }
  if (channelId !== appConfig.discord.channelId) {
    return "wrong_channel";
  }
  if (!appConfig.memberUserIds.includes(userId)) {
    return "not_member";
  }
  return undefined;
};
