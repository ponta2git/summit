import type { Client } from "discord.js";
import * as Effect from "effect/Effect";

import type { AppContext } from "../appContext.ts";
import type { AskingDeadlineResult } from "../db/ports.ts";
import type { SessionRow } from "../db/rows.ts";
import type { AppError } from "../errors/index.ts";
import { fromDatabaseCall } from "../errors/effect.ts";
import type { EvaluateDeadlineOptions } from "../features/ask-session/decide.ts";
import { updateAskMessage } from "../features/ask-session/messageEditor.ts";
import { skipReminderAndComplete } from "../features/reminder/send.ts";
import { shouldSkipReminder } from "../features/reminder/time.ts";
import { reflectAskingCancellation } from "./askSettleCancel.ts";
import { bestEffortMessageUpdate } from "../discord/shared/messageUpdates.ts";

const applyDecidedSideEffects = (
  client: Client,
  ctx: AppContext,
  session: SessionRow,
  settledAt: Date
): Effect.Effect<void, AppError> =>
  Effect.gen(function* () {
    if (session.reminderAt && shouldSkipReminder(settledAt, session.reminderAt)) {
      yield* fromDatabaseCall(
        () => skipReminderAndComplete(ctx, session, settledAt),
        "Failed to skip reminder and complete session."
      );
    }
    yield* bestEffortMessageUpdate(updateAskMessage(client, ctx, session), session.id, "ask");
  });

const applySettledDeadlineResult = (
  client: Client,
  ctx: AppContext,
  result: AskingDeadlineResult,
  settledAt: Date
): Effect.Effect<void, AppError> => {
  if (result.kind !== "transitioned") {
    return Effect.void;
  }
  if (result.outcome === "decided") {
    return applyDecidedSideEffects(client, ctx, result.session, settledAt);
  }
  return reflectAskingCancellation(client, ctx, result.session);
};

// source-of-truth: 判定ロジックは features/ask-session/decide.ts。
export const evaluateAndApplyDeadlineDecision = (
  client: Client,
  ctx: AppContext,
  session: SessionRow,
  options: EvaluateDeadlineOptions
): Effect.Effect<void, AppError> =>
  fromDatabaseCall(
    () => ctx.ports.sessionCommands.settleAskingDeadline({
      sessionId: session.id,
      now: options.now,
      memberCountExpected: options.memberCountExpected
    }),
    "Failed to settle ASKING aggregate at deadline."
  ).pipe(Effect.flatMap((result) => applySettledDeadlineResult(client, ctx, result, options.now)));
