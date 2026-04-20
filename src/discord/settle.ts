import { randomUUID } from "node:crypto";
import { ChannelType, type Client } from "discord.js";

import type { AppContext } from "../composition.js";
import { MEMBER_COUNT_EXPECTED } from "../config.js";
import type {
  ResponseRow,
  SessionRow
} from "../db/types.js";
import {
  evaluatePostponeVote,
  evaluateDeadline,
  type DecisionResult,
  type EvaluateDeadlineOptions,
  type PostponeDecisionResult
} from "../domain/index.js";
import * as askSendModule from "./ask/send.js";
import { logger } from "../logger.js";
import {
  deadlineFor,
  formatCandidateDateIso,
  parseCandidateDateIso,
  saturdayCandidateFrom
} from "../time/index.js";
import { renderAskBody } from "./ask/render.js";
import { renderPostponeBody } from "./postponeMessage.js";
import {
  buildAskMessageViewModel,
  buildPostponeMessageViewModel,
  buildSettleNoticeViewModel,
  type SettleNoticeViewModel
} from "./viewModels.js";

export type CancelReason =
  | "absent"
  | "deadline_unanswered"
  | "postpone_ng"
  | "postpone_unanswered"
  | "saturday_cancelled";

type SendPostponedAskMessage = (
  client: Client,
  ctx: AppContext,
  saturdaySession: SessionRow
) => Promise<void>;

type AskingCancelReason = Extract<
  CancelReason,
  "absent" | "deadline_unanswered" | "saturday_cancelled"
>;

// todo(ai): Phase E で sendPostponedAskMessage が ask/send.ts に追加されるまで暫定で optional 参照する。
const resolveSendPostponedAskMessage = (): SendPostponedAskMessage | undefined =>
  (
    askSendModule as unknown as {
      sendPostponedAskMessage?: SendPostponedAskMessage;
    }
  ).sendPostponedAskMessage;

const getTextChannel = async (client: Client, channelId: string) => {
  const channel = await client.channels.fetch(channelId);
  if (!channel || channel.type !== ChannelType.GuildText || !channel.isSendable()) {
    throw new Error("Configured channel is not sendable.");
  }
  return channel;
};

// why: DB 型を UI 層から分離 (ADR-0014, naming-boundaries-audit)
export const renderSettleNotice = (vm: SettleNoticeViewModel): { content: string } => {
  // why: DEV_SUPPRESS_MENTIONS=true なら mention 行を省く。単純な `${mentions}\n${cancel}` 連結だと
  //   mentions="" のとき先頭改行が残るため、filter で空文字を除外してから join する。
  // @see docs/adr/0011-dev-mention-suppression.md
  const lines = [
    vm.suppressMentions ? "" : vm.memberUserIds.map((id) => `<@${id}>`).join(" "),
    vm.cancelText
  ].filter((line) => line.length > 0);
  return { content: lines.join("\n") };
};

export const updateAskMessage = async (
  client: Client,
  ctx: AppContext,
  session: SessionRow
): Promise<void> => {
  if (!session.askMessageId) {return;}
  const channel = await getTextChannel(client, session.channelId);
  const memberRows = await ctx.ports.members.listMembers();
  const fresh = await ctx.ports.sessions.findSessionById(session.id);
  if (!fresh) {return;}
  // why: DB 型を UI 層から分離 (ADR-0014, naming-boundaries-audit)
  const responses = await ctx.ports.responses.listResponses(fresh.id);
  const vm = buildAskMessageViewModel(fresh, responses, memberRows);
  const rendered = renderAskBody(vm);
  try {
    const msg = await channel.messages.fetch(session.askMessageId);
    await msg.edit(rendered);
  } catch (error: unknown) {
    logger.warn(
      { error, sessionId: session.id, messageId: session.askMessageId },
      "Failed to update ask message."
    );
  }
};

const updatePostponeMessage = async (
  client: Client,
  ctx: AppContext,
  session: SessionRow,
  responses: readonly ResponseRow[],
  footerText: string
): Promise<void> => {
  if (!session.postponeMessageId) {return;}
  const channel = await getTextChannel(client, session.channelId);
  const memberRows = await ctx.ports.members.listMembers();
  const vm = buildPostponeMessageViewModel(session, responses, memberRows, {
    disabled: true,
    footerText
  });
  const rendered = renderPostponeBody(vm);
  const editPayload = {
    content: rendered.content ?? "",
    ...(rendered.components ? { components: rendered.components } : {})
  };
  try {
    const msg = await channel.messages.fetch(session.postponeMessageId);
    await msg.edit(editPayload);
  } catch (error: unknown) {
    logger.warn(
      { error, sessionId: session.id, messageId: session.postponeMessageId },
      "Failed to update postpone message."
    );
  }
};

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
    current.postponeCount === 1
      ? "saturday_cancelled"
      : reason === "absent"
        ? "absent"
        : "deadline_unanswered";

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

  logger.info(
    { sessionId, weekKey: cancelled.weekKey, from: "ASKING", to: "CANCELLED", reason: resolvedReason },
    "Session cancelled."
  );

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

  const transitioned = await ctx.ports.sessions.transitionStatus({
    id: sessionId,
    from: "CANCELLED",
    to: "POSTPONE_VOTING"
  });
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

const completeSaturdayAskingSession = async (
  ctx: AppContext,
  session: SessionRow
): Promise<void> => {
  const completed = await ctx.ports.sessions.transitionStatus({
    id: session.id,
    from: "DECIDED",
    to: "COMPLETED"
  });
  if (!completed) {return;}
  logger.info(
    {
      sessionId: session.id,
      weekKey: session.weekKey,
      from: "DECIDED",
      to: "COMPLETED",
      reason: "saturday session settled"
    },
    "Saturday session completed."
  );
};

/**
 * If all 4 members have responded with time choices (no ABSENT),
 * transition ASKING → DECIDED and record decided_start_at.
 * Returns true when the transition was performed.
 */
export const tryDecideIfAllTimeSlots = async (
  ctx: AppContext,
  session: SessionRow,
  decidedStart: Date
): Promise<boolean> => {
  const result = await ctx.ports.sessions.transitionStatus({
    id: session.id,
    from: "ASKING",
    to: "DECIDED",
    decidedStartAt: decidedStart
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
        decidedStartAt: decidedStart.toISOString()
      },
      "Session decided."
    );
    return true;
  }
  return false;
};

type DeadlineDecisionContext = Readonly<{
  client: Client;
  ctx: AppContext;
  session: SessionRow;
}>;

type DeadlineDecisionStrategy<K extends DecisionResult["kind"]> = (
  context: DeadlineDecisionContext,
  decision: Extract<DecisionResult, { kind: K }>
) => Promise<void>;

type DeadlineDecisionStrategyMap = {
  [K in DecisionResult["kind"]]: DeadlineDecisionStrategy<K>;
};

const toCancelReason = (
  reason: Extract<DecisionResult, { kind: "cancelled" }>["reason"]
): CancelReason => (reason === "all_absent" ? "absent" : "deadline_unanswered");

// why: DecisionResult.kind ごとの処理を strategy map 化し、分岐追加時の影響範囲を局所化する
// invariant: DecisionResult.kind の全ケースを map key として要求し、未実装を型エラーで検知する
// source-of-truth: 分岐の起点は DecisionResult.kind（domain/deadline.ts の判定結果）
const deadlineDecisionStrategies: DeadlineDecisionStrategyMap = {
  decided: async ({ client, ctx, session }, decision) => {
    const decided = await tryDecideIfAllTimeSlots(ctx, session, decision.startAt);
    if (!decided || session.postponeCount !== 1) {
      return;
    }
    // source-of-truth: DECIDED 時点の DB 状態で ask メッセージを再描画してから終端化する。
    await updateAskMessage(client, ctx, session);
    await completeSaturdayAskingSession(ctx, session);
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

const postponeDecisionFooter = (
  decision: Exclude<PostponeDecisionResult, { kind: "pending" }>
): string => {
  if (decision.kind === "all_ok") {
    return "順延されました";
  }
  return "この回はお流れになりました";
};

export async function settlePostponeVotingSession(
  client: Client,
  ctx: AppContext,
  session: SessionRow,
  now: Date,
): Promise<void> {
  const current = await ctx.ports.sessions.findSessionById(session.id);
  if (!current || current.status !== "POSTPONE_VOTING") {
    return;
  }

  const responses = await ctx.ports.responses.listResponses(current.id);
  const decision = evaluatePostponeVote(current, responses, {
    memberCountExpected: MEMBER_COUNT_EXPECTED,
    now
  });
  if (decision.kind === "pending") {
    return;
  }

  if (decision.kind === "all_ok") {
    const postponed = await ctx.ports.sessions.transitionStatus({
      id: current.id,
      from: "POSTPONE_VOTING",
      to: "POSTPONED"
    });
    if (!postponed) {return;}
    await updatePostponeMessage(client, ctx, postponed, responses, postponeDecisionFooter(decision));

    const saturdayCandidate = saturdayCandidateFrom(parseCandidateDateIso(postponed.candidateDateIso));
    const saturdaySession = await ctx.ports.sessions.createAskSession({
      id: randomUUID(),
      weekKey: postponed.weekKey,
      postponeCount: 1,
      candidateDateIso: formatCandidateDateIso(saturdayCandidate),
      channelId: postponed.channelId,
      deadlineAt: deadlineFor(saturdayCandidate)
    });
    if (!saturdaySession) {
      logger.info(
        { sessionId: postponed.id, weekKey: postponed.weekKey, reason: "saturday session already exists" },
        "Skipped creating postponed Saturday session."
      );
      return;
    }

    const sendPostponedAskMessage = resolveSendPostponedAskMessage();
    if (!sendPostponedAskMessage) {
      logger.warn(
        { sessionId: postponed.id, weekKey: postponed.weekKey, saturdaySessionId: saturdaySession.id },
        "sendPostponedAskMessage is not available yet."
      );
      return;
    }
    await sendPostponedAskMessage(client, ctx, saturdaySession);
    return;
  }

  const cancelled = await ctx.ports.sessions.transitionStatus({
    id: current.id,
    from: "POSTPONE_VOTING",
    to: "CANCELLED",
    cancelReason: decision.reason
  });
  if (!cancelled) {return;}
  await updatePostponeMessage(client, ctx, cancelled, responses, postponeDecisionFooter(decision));
}
