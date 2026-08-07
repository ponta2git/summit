import type { Client } from "discord.js";
import { type ResultAsync, okAsync, safeTry } from "neverthrow";

import type { AppContext } from "../appContext.js";
import type { AskingDeadlineResult } from "../db/ports.js";
import type { SessionRow } from "../db/rows.js";
import type { AppError } from "../errors/index.js";
import { fromDatabasePromise, fromDiscordPromise } from "../errors/result.js";
import type { EvaluateDeadlineOptions } from "../features/ask-session/decide.js";
import { updateAskMessage } from "../features/ask-session/messageEditor.js";
import { skipReminderAndComplete } from "../features/reminder/send.js";
import { shouldSkipReminder } from "../features/reminder/time.js";
import { reflectAskingCancellation } from "./askSettleCancel.js";

const applyDecidedSideEffects = (
  client: Client,
  ctx: AppContext,
  session: SessionRow
): ResultAsync<void, AppError> =>
  safeTry(async function* () {
    yield* fromDiscordPromise(
      updateAskMessage(client, ctx, session),
      "Failed to update ask message after decide."
    );
    if (session.reminderAt && shouldSkipReminder(ctx.clock.now(), session.reminderAt)) {
      yield* fromDatabasePromise(
        skipReminderAndComplete(ctx, session, ctx.clock.now()),
        "Failed to skip reminder and complete session."
      );
    }
    return okAsync(undefined);
  });

const applySettledDeadlineResult = (
  client: Client,
  ctx: AppContext,
  result: AskingDeadlineResult
): ResultAsync<void, AppError> => {
  if (result.kind !== "transitioned") {
    return okAsync(undefined);
  }
  if (result.outcome === "decided") {
    return applyDecidedSideEffects(client, ctx, result.session);
  }
  return reflectAskingCancellation(client, ctx, result.session);
};

// source-of-truth: 判定ロジックは features/ask-session/decide.ts。
export const evaluateAndApplyDeadlineDecision = (
  client: Client,
  ctx: AppContext,
  session: SessionRow,
  options: EvaluateDeadlineOptions
): ResultAsync<void, AppError> =>
  fromDatabasePromise(
    ctx.ports.sessionCommands.settleAskingDeadline({
      sessionId: session.id,
      now: options.now,
      memberCountExpected: options.memberCountExpected
    }),
    "Failed to settle ASKING aggregate at deadline."
  ).andThen((result) => applySettledDeadlineResult(client, ctx, result));
