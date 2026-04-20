import type { Client } from "discord.js";

import type { AppContext } from "../../composition.js";
import type { ResponseRow, SessionRow } from "../../db/types.js";
import { evaluateDeadline, type DecisionResult, type EvaluateDeadlineOptions } from "../../domain/index.js";
import { logger } from "../../logger.js";
import { renderPostponeBody } from "../postpone-voting/render.js";
import { buildPostponeMessageViewModel, buildSettleNoticeViewModel } from "../../discord/shared/viewModels.js";
import { type CancelReason, getTextChannel, renderSettleNotice, updateAskMessage } from "../../discord/shared/messages.js";
import { computeReminderAt, shouldSkipReminder, skipReminderAndComplete } from "../reminder/send.js";
import { sendDecidedAnnouncement } from "../decided-announcement/send.js";

type AskingCancelReason = Extract<CancelReason, "absent" | "deadline_unanswered" | "saturday_cancelled">;

/**
 * Settles an ASKING session into a cancelled path.
 *
 * @remarks
 * 金曜回 (postponeCount=0) は CANCELLED → POSTPONE_VOTING へ進み、順延投票を送る。
 * 土曜回 (postponeCount=1) は `saturday_cancelled` で CANCELLED 終端にする。
 */
export const settleAskingSession = async (
  client: Client,
  ctx: AppContext,
  sessionId: string,
  reason: CancelReason
): Promise<void> => {
  const current = await ctx.ports.sessions.findSessionById(sessionId);
  if (!current) {return;}
  if (current.status !== "ASKING") {
    // state: ASKING 以外は遷移せず skip 理由を明示して終了する
    logger.info(
      { sessionId, weekKey: current.weekKey, status: current.status, reason: "non-asking status, skip settle" },
      "settleAskingSession called on non-ASKING session; skipping."
    );
    return;
  }

  const resolvedReason: AskingCancelReason =
    current.postponeCount === 1 ? "saturday_cancelled" : reason === "absent" ? "absent" : "deadline_unanswered";

  const cancelled = await ctx.ports.sessions.transitionStatus({
    id: sessionId,
    from: "ASKING",
    to: "CANCELLED",
    cancelReason: resolvedReason
  });
  if (!cancelled) {
    // state: ASKING→CANCELLED の CAS 競合敗北は無害な race lost として扱う
    logger.info(
      { sessionId, weekKey: current.weekKey, from: "ASKING", to: "CANCELLED", reason: "race lost at transition" },
      "ASKING→CANCELLED race; another path settled first."
    );
    return;
  }

  logger.info({ sessionId, weekKey: cancelled.weekKey, from: "ASKING", to: "CANCELLED", reason: resolvedReason }, "Session cancelled.");
  await updateAskMessage(client, ctx, cancelled);
  const channel = await getTextChannel(client, cancelled.channelId);

  // why: DB 型を UI 層から分離 (ADR-0014, naming-boundaries-audit)
  const settleVm = buildSettleNoticeViewModel(resolvedReason);
  await channel.send(renderSettleNotice(settleVm));

  if (cancelled.postponeCount === 1) {
    // state: 土曜回 (postponeCount=1) は順延確認へ進めず、CANCELLED を終端として週を終了する。
    return;
  }

  const postponeVm = buildPostponeMessageViewModel(cancelled);
  const postponeSent = await channel.send(renderPostponeBody(postponeVm));
  await ctx.ports.sessions.updatePostponeMessageId(cancelled.id, postponeSent.id);

  const transitioned = await ctx.ports.sessions.transitionStatus({ id: sessionId, from: "CANCELLED", to: "POSTPONE_VOTING" });
  if (transitioned) {
    // state: CANCELLED→POSTPONE_VOTING は順延投票メッセージ送信を契機に 1 回だけ遷移する
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
};

/**
 * If all 4 members have responded with time choices (no ABSENT),
 * transition ASKING → DECIDED and record decided_start_at along with reminderAt.
 * Returns true when the transition was performed.
 *
 * @remarks
 * reminderAt = decidedStart + REMINDER_LEAD_MINUTES(-15 分)。この時点では reminderSentAt は更新しない。
 * 実際のリマインド送信は scheduler の毎分 tick が DECIDED を拾って行う（§5.2, §9.1）。
 */
export const tryDecideIfAllTimeSlots = async (
  ctx: AppContext,
  session: SessionRow,
  decidedStart: Date
): Promise<boolean> => {
  const reminderAt = computeReminderAt(decidedStart);
  const result = await ctx.ports.sessions.transitionStatus({
    id: session.id,
    from: "ASKING",
    to: "DECIDED",
    decidedStartAt: decidedStart,
    reminderAt
  });
  if (result) {
    // state: ASKING で全員の時間回答が揃った場合のみ DECIDED へ遷移する
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
    return true;
  }
  return false;
};

type DeadlineDecisionContext = Readonly<{ client: Client; ctx: AppContext; session: SessionRow }>;
type DeadlineDecisionStrategy<K extends DecisionResult["kind"]> = (
  context: DeadlineDecisionContext,
  decision: Extract<DecisionResult, { kind: K }>
) => Promise<void>;
type DeadlineDecisionStrategyMap = { [K in DecisionResult["kind"]]: DeadlineDecisionStrategy<K> };

const toCancelReason = (reason: Extract<DecisionResult, { kind: "cancelled" }>["reason"]): CancelReason =>
  reason === "all_absent" ? "absent" : "deadline_unanswered";

// why: DecisionResult.kind ごとの処理を strategy map 化し、分岐追加時の影響範囲を局所化する
// invariant: DecisionResult.kind の全ケースを map key として要求し、未実装を型エラーで検知する
// source-of-truth: 分岐の起点は DecisionResult.kind（domain/deadline.ts の判定結果）
const deadlineDecisionStrategies: DeadlineDecisionStrategyMap = {
  decided: async ({ client, ctx, session }, decision) => {
    const decided = await tryDecideIfAllTimeSlots(ctx, session, decision.startAt);
    if (!decided) {return;}
    // source-of-truth: DECIDED 遷移後の最新 DB 状態 (reminderAt を含む) を元に再描画する
    const fresh = await ctx.ports.sessions.findSessionById(session.id);
    if (!fresh) {return;}
    await updateAskMessage(client, ctx, fresh);
    // why: §5.1 開催決定メッセージ (別投稿) を送る。ASKING→DECIDED の CAS が 1 回しか成功しないため冪等。
    // source-of-truth: requirements/base.md §5.1
    await sendDecidedAnnouncement(client, ctx, fresh);
    // state: reminderAt まで 10 分未満で DECIDED へ遷移した場合 (遅延 recovery 等) はリマインド省略して COMPLETED へ
    if (fresh.reminderAt && shouldSkipReminder(ctx.clock.now(), fresh.reminderAt)) {
      await skipReminderAndComplete(ctx, fresh, ctx.clock.now());
    }
  },
  cancelled: async ({ client, ctx, session }, decision) => {
    await settleAskingSession(client, ctx, session.id, toCancelReason(decision.reason));
  },
  pending: async () => {}
};

const applyDeadlineDecisionByStrategy = async <K extends DecisionResult["kind"]>(
  context: DeadlineDecisionContext,
  decision: Extract<DecisionResult, { kind: K }>
): Promise<void> => deadlineDecisionStrategies[decision.kind](context, decision);

export const applyDeadlineDecision = async (
  client: Client,
  ctx: AppContext,
  session: SessionRow,
  decision: DecisionResult
): Promise<void> => {
  await applyDeadlineDecisionByStrategy({ client, ctx, session }, decision);
};

// source-of-truth: 判定ロジックは domain/deadline.ts が正本
export const evaluateAndApplyDeadlineDecision = async (
  client: Client,
  ctx: AppContext,
  session: SessionRow,
  responses: readonly ResponseRow[],
  options: EvaluateDeadlineOptions
): Promise<void> => {
  const decision = evaluateDeadline(session, responses, options);
  await applyDeadlineDecision(client, ctx, session, decision);
};
