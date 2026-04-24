import type { Client } from "discord.js";
import { type ResultAsync, okAsync, safeTry } from "neverthrow";

import type { AppContext } from "../appContext.js";
import type { SessionRow, ResponseRow } from "../db/rows.js";
import type { AppError } from "../errors/index.js";
import { fromDatabasePromise, fromDiscordPromise } from "../errors/result.js";
import type { CancelReason } from "../features/ask-session/cancelReason.js";
import { evaluateDeadline, type DecisionResult, type EvaluateDeadlineOptions } from "../features/ask-session/decide.js";
import { updateAskMessage } from "../features/ask-session/messageEditor.js";
import { settleAskingSession, tryDecideIfAllTimeSlots } from "../features/ask-session/settle.js";
import { sendDecidedAnnouncement } from "../features/decided-announcement/send.js";
import { skipReminderAndComplete } from "../features/reminder/send.js";
import { shouldSkipReminder } from "../features/reminder/time.js";

const toCancelReason = (reason: Extract<DecisionResult, { kind: "cancelled" }>["reason"]): CancelReason =>
  reason === "all_absent" ? "absent" : "deadline_unanswered";

/**
 * Apply a deadline decision: route cancelled / decided / pending into the right side-effect sequence.
 *
 * @remarks
 * source-of-truth: DECIDED 遷移後の最新 DB 状態 (`reminderAt` 含む) を元に再描画する。
 * idempotent: ASKING→DECIDED の CAS は 1 回しか成功しないため開催決定メッセージも一度きり。
 * @see ADR-0040
 */
export const applyDeadlineDecision = (
  client: Client,
  ctx: AppContext,
  session: SessionRow,
  decision: DecisionResult
): ResultAsync<void, AppError> =>
  safeTry(async function* () {
    switch (decision.kind) {
      case "pending":
        return okAsync(undefined);
      case "cancelled":
        yield* settleAskingSession(client, ctx, session.id, toCancelReason(decision.reason));
        return okAsync(undefined);
      case "decided": {
        const decided = yield* tryDecideIfAllTimeSlots(ctx, session, decision.startAt);
        if (!decided) {return okAsync(undefined);}
        const fresh = yield* fromDatabasePromise(
          ctx.ports.sessions.findSessionById(session.id),
          "Failed to reload decided session."
        );
        if (!fresh) {return okAsync(undefined);}
        yield* fromDiscordPromise(
          updateAskMessage(client, ctx, fresh),
          "Failed to update ask message after decide."
        );
        yield* fromDiscordPromise(
          sendDecidedAnnouncement(client, ctx, fresh),
          "Failed to send decided announcement."
        );
        if (fresh.reminderAt && shouldSkipReminder(ctx.clock.now(), fresh.reminderAt)) {
          yield* fromDatabasePromise(
            skipReminderAndComplete(ctx, fresh, ctx.clock.now()),
            "Failed to skip reminder and complete session."
          );
        }
        return okAsync(undefined);
      }
    }
  });

// source-of-truth: 判定ロジックは features/ask-session/decide.ts。
export const evaluateAndApplyDeadlineDecision = (
  client: Client,
  ctx: AppContext,
  session: SessionRow,
  responses: readonly ResponseRow[],
  options: EvaluateDeadlineOptions
): ResultAsync<void, AppError> =>
  applyDeadlineDecision(client, ctx, session, evaluateDeadline(session, responses, options));
