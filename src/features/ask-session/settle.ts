import type { Client } from "discord.js";
import { type ResultAsync, okAsync, safeTry } from "neverthrow";

import type { AppContext } from "../../appContext.js";
import type { SessionRow } from "../../db/rows.js";
import type { AppError } from "../../errors/index.js";
import { fromDatabasePromise, fromDiscordPromise } from "../../errors/result.js";
import { logger } from "../../logger.js";
import { renderPostponeBody } from "../postpone-voting/render.js";
import { buildSettleNoticeViewModel, renderSettleNotice } from "./viewModel.js";
import { buildPostponeMessageViewModel } from "../postpone-voting/viewModel.js";
import { getTextChannel } from "../../discord/shared/channels.js";
import type { CancelReason } from "./cancelReason.js";
import { updateAskMessage } from "./messageEditor.js";
import { computeReminderAt } from "../reminder/time.js";
import { parseCandidateDateIso, postponeDeadlineFor } from "../../time/index.js";

type AskingCancelReason = Extract<CancelReason, "absent" | "deadline_unanswered" | "saturday_cancelled">;

/**
 * Settles an ASKING session into the cancelled path.
 *
 * @remarks
 * state: 金曜回は CANCELLED → POSTPONE_VOTING。土曜回は `saturday_cancelled` を記録し COMPLETED へ収束。
 * race: race-lost（CAS が undefined）は無害として `Ok(void)` で終了。
 */
export const settleAskingSession = (
  client: Client,
  ctx: AppContext,
  sessionId: string,
  reason: CancelReason
): ResultAsync<void, AppError> =>
  safeTry(async function* () {
    const current = yield* fromDatabasePromise(
      ctx.ports.sessions.findSessionById(sessionId),
      "Failed to load session for ask settle."
    );
    if (!current) {return okAsync(undefined);}
    if (current.status !== "ASKING") {
      logger.info(
        { sessionId, weekKey: current.weekKey, status: current.status, reason: "non-asking status, skip settle" },
        "settleAskingSession called on non-ASKING session; skipping."
      );
      return okAsync(undefined);
    }

    const resolvedReason: AskingCancelReason =
      current.postponeCount === 1 ? "saturday_cancelled" : reason === "absent" ? "absent" : "deadline_unanswered";

    const now = ctx.clock.now();
    // state: ASKING→CANCELLED の CAS。
    //   why: settle notice と postpone message は直接送信で順序を保証する（outbox 経由だと worker
    //     周期ぶん settle 通知が遅延し postpone vote と UX 順序が逆転）。outbox 化は renderer
    //     coverage 完成後に再検討。@see ADR-0035
    const cancelled = yield* fromDatabasePromise(
      ctx.ports.sessions.cancelAsking({ id: sessionId, now, reason: resolvedReason }),
      "Failed to cancel ASKING session."
    );
    if (!cancelled) {
      logger.info(
        { sessionId, weekKey: current.weekKey, from: "ASKING", to: "CANCELLED", reason: "race lost at transition" },
        "ASKING→CANCELLED race; another path settled first."
      );
      return okAsync(undefined);
    }

    logger.info(
      { sessionId, weekKey: cancelled.weekKey, from: "ASKING", to: "CANCELLED", reason: resolvedReason },
      "Session cancelled."
    );
    yield* fromDiscordPromise(
      updateAskMessage(client, ctx, cancelled),
      "Failed to update ask message after cancel."
    );
    const channel = yield* fromDiscordPromise(
      getTextChannel(client, cancelled.channelId),
      "Failed to resolve text channel for settle notice."
    );
    const settleVm = buildSettleNoticeViewModel(resolvedReason);
    yield* fromDiscordPromise(
      channel.send(renderSettleNotice(settleVm)),
      "Failed to send settle notice."
    );

    if (cancelled.postponeCount === 1) {
      // regression: 土曜回中止は CANCELLED に滞留させず短命中間を経由して COMPLETED へ収束させる。
      const completed = yield* fromDatabasePromise(
        ctx.ports.sessions.completeCancelledSession({ id: cancelled.id, now: ctx.clock.now() }),
        "Failed to complete cancelled Saturday session."
      );
      if (completed) {
        logger.info(
          {
            sessionId: completed.id,
            weekKey: completed.weekKey,
            from: "CANCELLED",
            to: "COMPLETED",
            reason: resolvedReason
          },
          "Cancelled Saturday session completed."
        );
      }
      return okAsync(undefined);
    }

    const postponeVm = buildPostponeMessageViewModel(cancelled);
    const postponeSent = yield* fromDiscordPromise(
      channel.send(renderPostponeBody(postponeVm)),
      "Failed to send postpone vote message."
    );
    yield* fromDatabasePromise(
      ctx.ports.sessions.updatePostponeMessageId(cancelled.id, postponeSent.id),
      "Failed to record postpone message id."
    );

    const transitioned = yield* fromDatabasePromise(
      ctx.ports.sessions.startPostponeVoting({
        id: sessionId,
        now: ctx.clock.now(),
        postponeDeadlineAt: postponeDeadlineFor(parseCandidateDateIso(cancelled.candidateDateIso))
      }),
      "Failed to start postpone voting."
    );
    if (transitioned) {
      logger.info(
        {
          sessionId,
          weekKey: cancelled.weekKey,
          from: "CANCELLED",
          to: "POSTPONE_VOTING",
          reason: "postpone vote requested after cancel",
          postponeMessageId: postponeSent.id
        },
        "Postpone voting started."
      );
    }
    return okAsync(undefined);
  });

/**
 * Transitions ASKING → DECIDED when every member answered with a time slot (no ABSENT).
 *
 * @remarks
 * state: CAS。成功時のみ `true`。`reminderAt` は decidedStart からのオフセットで計算し、
 *   `reminderSentAt` はこの段階では更新しない。@see src/features/reminder/send.ts
 */
export const tryDecideIfAllTimeSlots = (
  ctx: AppContext,
  session: SessionRow,
  decidedStart: Date
): ResultAsync<boolean, AppError> =>
  safeTry(async function* () {
    const reminderAt = computeReminderAt(decidedStart);
    const result = yield* fromDatabasePromise(
      ctx.ports.sessions.decideAsking({
        id: session.id,
        now: ctx.clock.now(),
        decidedStartAt: decidedStart,
        reminderAt
      }),
      "Failed to transition ASKING→DECIDED."
    );
    if (result) {
      logger.info(
        {
          sessionId: session.id,
          weekKey: session.weekKey,
          from: "ASKING",
          to: "DECIDED",
          reason: "all time-choice responses received",
          decidedStartAt: decidedStart.toISOString(),
          reminderAt: reminderAt.toISOString()
        },
        "Session decided."
      );
      return okAsync(true);
    }
    return okAsync(false);
  });

