import type { Client } from "discord.js";
import { type ResultAsync, okAsync, safeTry } from "neverthrow";

import type { AppContext } from "../appContext.ts";
import type { AskingDeadlineResult } from "../db/ports.ts";
import type { SessionRow } from "../db/rows.ts";
import type { AppError } from "../errors/index.ts";
import { fromDatabaseCall } from "../errors/result.ts";
import type { EvaluateDeadlineOptions } from "../features/ask-session/decide.ts";
import { updateAskMessage } from "../features/ask-session/messageEditor.ts";
import { skipReminderAndComplete } from "../features/reminder/send.ts";
import { shouldSkipReminder } from "../features/reminder/time.ts";
import { reflectAskingCancellation } from "./askSettleCancel.ts";

const applyDecidedSideEffects = (
  client: Client,
  ctx: AppContext,
  session: SessionRow
): ResultAsync<void, AppError> =>
  safeTry(async function* () {
    yield* updateAskMessage(client, ctx, session);
    if (session.reminderAt && shouldSkipReminder(ctx.clock.now(), session.reminderAt)) {
      yield* fromDatabaseCall(
        () => skipReminderAndComplete(ctx, session, ctx.clock.now()),
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
  fromDatabaseCall(
    () => ctx.ports.sessionCommands.settleAskingDeadline({
      sessionId: session.id,
      now: options.now,
      memberCountExpected: options.memberCountExpected
    }),
    "Failed to settle ASKING aggregate at deadline."
  ).andThen((result) => applySettledDeadlineResult(client, ctx, result));
