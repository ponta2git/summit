import type { Client } from "discord.js";
import { type ResultAsync, okAsync, safeTry } from "neverthrow";

import type { AppContext } from "../../appContext.js";
import type { ResponseRow, SessionRow } from "../../db/rows.js";
import { evaluateDeadline, type DecisionResult, type EvaluateDeadlineOptions } from "./decide.js";
import type { AppError } from "../../errors/index.js";
import { fromDatabasePromise, fromDiscordPromise } from "../../errors/result.js";
import { logger } from "../../logger.js";
import { renderPostponeBody } from "../postpone-voting/render.js";
import { buildSettleNoticeViewModel, renderSettleNotice } from "./viewModel.js";
import { buildPostponeMessageViewModel } from "../postpone-voting/viewModel.js";
import { getTextChannel } from "../../discord/shared/channels.js";
import type { CancelReason } from "./cancelReason.js";
import { updateAskMessage } from "./messageEditor.js";
import { computeReminderAt, shouldSkipReminder, skipReminderAndComplete } from "../reminder/send.js";
import { sendDecidedAnnouncement } from "../decided-announcement/send.js";
import { parseCandidateDateIso, postponeDeadlineFor } from "../../time/index.js";

type AskingCancelReason = Extract<CancelReason, "absent" | "deadline_unanswered" | "saturday_cancelled">;

/**
 * Settles an ASKING session into a cancelled path.
 *
 * @remarks
 * 金曜回 (postponeCount=0) は CANCELLED → POSTPONE_VOTING へ進み、順延投票を送る。
 * 土曜回 (postponeCount=1) は `saturday_cancelled` を記録したうえで COMPLETED に収束させる。
 * race: race-lost (CAS が undefined) は無害なため `Ok(void)` として終了する。
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
    //   source-of-truth: settle notice と postpone message は同じ直接送信経路で順序保証する (FR second-opinion H1)。
    //     outbox 経由にすると worker 周期 (≤10s) 分だけ settle 通知が遅延し、postpone vote との UX 順序が逆転する。
    //     outbox 化は renderer coverage が ask/postpone 全体を覆ってから (ADR-0035 Consequences)。
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
      // regression: 土曜回中止は CANCELLED に滞留させず、短命中間を経由して COMPLETED へ収束させる。
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
 * If all 4 members have responded with time choices (no ABSENT),
 * transition ASKING → DECIDED and record decided_start_at along with reminderAt.
 * Resolves to true when the transition was performed.
 *
 * @remarks
 * reminderAt = decidedStart + REMINDER_LEAD_MINUTES(-15 分)。この時点では reminderSentAt は更新しない。
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

const toCancelReason = (reason: Extract<DecisionResult, { kind: "cancelled" }>["reason"]): CancelReason =>
  reason === "all_absent" ? "absent" : "deadline_unanswered";

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
        // source-of-truth: DECIDED 遷移後の最新 DB 状態 (reminderAt 含む) を元に再描画する
        const fresh = yield* fromDatabasePromise(
          ctx.ports.sessions.findSessionById(session.id),
          "Failed to reload decided session."
        );
        if (!fresh) {return okAsync(undefined);}
        yield* fromDiscordPromise(
          updateAskMessage(client, ctx, fresh),
          "Failed to update ask message after decide."
        );
        // why: §5.1 開催決定メッセージ。ASKING→DECIDED の CAS が 1 回しか成功しないため冪等。
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

// source-of-truth: 判定ロジックは ./decide.ts が正本
export const evaluateAndApplyDeadlineDecision = (
  client: Client,
  ctx: AppContext,
  session: SessionRow,
  responses: readonly ResponseRow[],
  options: EvaluateDeadlineOptions
): ResultAsync<void, AppError> =>
  applyDeadlineDecision(client, ctx, session, evaluateDeadline(session, responses, options));
