import { ChannelType, type Client } from "discord.js";

import {
  findSessionById,
  listMembers,
  listResponses,
  setPostponeMessageId,
  transitionStatus
} from "../db/repositories/index.js";
import type {
  DbLike,
  ResponseRow,
  SessionRow
} from "../db/types.js";
import {
  evaluateDeadline,
  type DecisionResult,
  type EvaluateDeadlineOptions
} from "../domain/index.js";
import { logger } from "../logger.js";
import { assertNever } from "../util/assertNever.js";
import { renderAskBody } from "./ask/render.js";
import { renderPostponeBody } from "./postponeMessage.js";
import {
  buildAskMessageViewModel,
  buildPostponeMessageViewModel,
  buildSettleNoticeViewModel,
  type SettleNoticeViewModel
} from "./viewModels.js";

export type CancelReason = "absent" | "deadline_unanswered";

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

export const refreshAskMessage = async (
  client: Client,
  db: DbLike,
  session: SessionRow
): Promise<void> => {
  if (!session.askMessageId) {return;}
  const channel = await getTextChannel(client, session.channelId);
  const memberRows = await listMembers(db);
  const fresh = await findSessionById(db, session.id);
  if (!fresh) {return;}
  // why: DB 型を UI 層から分離 (ADR-0014, naming-boundaries-audit)
  const responses = await listResponses(db, fresh.id);
  const vm = buildAskMessageViewModel(fresh, responses, memberRows);
  const rendered = renderAskBody(vm);
  try {
    const msg = await channel.messages.fetch(session.askMessageId);
    await msg.edit(rendered);
  } catch (error: unknown) {
    logger.warn(
      { error, sessionId: session.id, messageId: session.askMessageId },
      "Failed to refresh ask message."
    );
  }
};

/**
 * Transition an ASKING session to CANCELLED, refresh ask message,
 * post the cancel message, post the postpone confirmation message,
 * and transition CANCELLED → POSTPONE_VOTING. Fully idempotent.
 */
export const settleAskingSession = async (
  client: Client,
  db: DbLike,
  sessionId: string,
  reason: CancelReason
): Promise<void> => {
  const current = await findSessionById(db, sessionId);
  if (!current) {return;}
  if (current.status !== "ASKING") {
    // state: ASKING 以外は遷移せず skip 理由を明示して終了する
    logger.info(
      { sessionId, weekKey: current.weekKey, status: current.status, reason: "non-asking status, skip settle" },
      "settleAskingSession called on non-ASKING session; skipping."
    );
    return;
  }

  const cancelled = await transitionStatus(db, {
    id: sessionId,
    from: "ASKING",
    to: "CANCELLED",
    cancelReason: reason
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
    { sessionId, weekKey: cancelled.weekKey, from: "ASKING", to: "CANCELLED", reason },
    "Session cancelled."
  );

  await refreshAskMessage(client, db, cancelled);

  const channel = await getTextChannel(client, cancelled.channelId);

  // why: DB 型を UI 層から分離 (ADR-0014, naming-boundaries-audit)
  const settleVm = buildSettleNoticeViewModel(reason);
  await channel.send(renderSettleNotice(settleVm));

  const postponeVm = buildPostponeMessageViewModel(cancelled);
  const postponeSent = await channel.send(renderPostponeBody(postponeVm));
  await setPostponeMessageId(db, cancelled.id, postponeSent.id);

  const transitioned = await transitionStatus(db, {
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

/**
 * If all 4 members have responded with time choices (no ABSENT),
 * transition ASKING → DECIDED and record decided_start_at.
 * Returns true when the transition was performed.
 */
export const tryDecideIfAllTimeSlots = async (
  db: DbLike,
  session: SessionRow,
  decidedStart: Date
): Promise<boolean> => {
  const result = await transitionStatus(db, {
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

export const applyDeadlineDecision = async (
  client: Client,
  db: DbLike,
  session: SessionRow,
  decision: DecisionResult
): Promise<void> => {
  if (decision.kind === "decided") {
    await tryDecideIfAllTimeSlots(db, session, decision.startAt);
    return;
  }

  if (decision.kind === "cancelled") {
    await settleAskingSession(
      client,
      db,
      session.id,
      decision.reason === "all_absent" ? "absent" : "deadline_unanswered"
    );
    return;
  }

  if (decision.kind === "pending") {
    return;
  }

  // invariant: 将来 DecisionResult.kind を追加した際に型エラーで気付くため assertNever を残す
  return assertNever(decision, "applyDeadlineDecision");
};

// source-of-truth: 判定ロジックは domain/deadline.ts が正本
export const evaluateAndApplyDeadlineDecision = async (
  client: Client,
  db: DbLike,
  session: SessionRow,
  responses: readonly ResponseRow[],
  options: EvaluateDeadlineOptions
): Promise<void> => {
  const decision = evaluateDeadline(session, responses, options);
  await applyDeadlineDecision(client, db, session, decision);
};
