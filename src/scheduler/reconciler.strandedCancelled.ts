import type { Client } from "discord.js";

import type { AppContext } from "../appContext.js";
import type { SessionRow } from "../db/rows.js";
import { getTextChannel } from "../discord/shared/channels.js";
import { updateAskMessage } from "../features/ask-session/messageEditor.js";
import type { SettleCancelReason } from "../features/ask-session/messages.js";
import {
  buildSettleNoticeViewModel,
  renderSettleNotice
} from "../features/ask-session/viewModel.js";
import { renderPostponeBody } from "../features/postpone-voting/render.js";
import { buildPostponeMessageViewModel } from "../features/postpone-voting/viewModel.js";
import { logger } from "../logger.js";
import { parseCandidateDateIso, postponeDeadlineFor } from "../time/index.js";

/**
 * Invariant A: Promote stranded CANCELLED sessions to their next canonical state.
 *
 * @remarks
 * state: CANCELLED は短命中間状態 (ADR-0001)。crash 等で宙づり行が残った場合に収束させる。
 * 土曜 (postponeCount=1) は COMPLETED、金曜は順延期限前なら POSTPONE_VOTING、期限後は COMPLETED。
 * CANCELLED→SKIPPED は許可遷移に無いため終端は COMPLETED を採用する。
 * @see ADR-0033
 */
export const reconcileStrandedCancelled = async (
  client: Client,
  ctx: AppContext
): Promise<number> => {
  const stranded = await ctx.ports.sessions.findStrandedCancelledSessions();
  let promoted = 0;
  const now = ctx.clock.now();

  for (const session of stranded) {
    try {
      const next = await promoteStranded(client, ctx, session, now);
      if (next) {
        promoted += 1;
        logger.info(
          {
            event: "reconciler.cancelled_promoted",
            sessionId: session.id,
            weekKey: session.weekKey,
            from: "CANCELLED",
            to: next.to,
            reason: next.reason
          },
          "Reconciler: promoted stranded CANCELLED session."
        );
      }
    } catch (error: unknown) {
      logger.error(
        {
          error,
          event: "reconciler.cancelled_promoted_failed",
          sessionId: session.id,
          weekKey: session.weekKey
        },
        "Reconciler: failed to promote stranded CANCELLED session."
      );
    }
  }
  return promoted;
};

const resolveSettleCancelReason = (session: SessionRow): SettleCancelReason => {
  const reason = session.cancelReason;
  if (
    reason === "absent" ||
    reason === "deadline_unanswered" ||
    reason === "saturday_cancelled"
  ) {
    return reason;
  }
  // state: cancelReason 未記録 / 想定外値は postponeCount から妥当なデフォルトへ fallback。
  return session.postponeCount === 1 ? "saturday_cancelled" : "deadline_unanswered";
};

// race: cleanup は通常経路 (settleAskingSession) の updateAskMessage → settle 通知送信 を
//   ミラーする。crash 時は settle 通知 1 通の重複投稿を許容 (DB-as-SoT, ADR-0001)。
const emitCancelledUiCleanup = async (
  client: Client,
  ctx: AppContext,
  session: SessionRow
): Promise<void> => {
  await updateAskMessage(client, ctx, session);
  const channel = await getTextChannel(client, session.channelId);
  const settleVm = buildSettleNoticeViewModel(resolveSettleCancelReason(session));
  await channel.send(renderSettleNotice(settleVm));
};

const promoteStranded = async (
  client: Client,
  ctx: AppContext,
  session: SessionRow,
  now: Date
): Promise<{ readonly to: "POSTPONE_VOTING" | "COMPLETED"; readonly reason: string } | undefined> => {
  if (session.postponeCount === 1) {
    // state: 土曜回の CANCELLED は順延経路が無いため UI cleanup → COMPLETED。
    await emitCancelledUiCleanup(client, ctx, session);
    const completed = await ctx.ports.sessions.completeCancelledSession({
      id: session.id,
      now
    });
    if (!completed) {return undefined;}
    return { to: "COMPLETED", reason: "saturday_cancelled_stranded" };
  }

  const candidateDate = parseCandidateDateIso(session.candidateDateIso);
  const postponeDeadline = postponeDeadlineFor(candidateDate);
  if (now.getTime() >= postponeDeadline.getTime()) {
    // state: 順延期限超過なら投票経路無しで COMPLETED に収束。
    await emitCancelledUiCleanup(client, ctx, session);
    const completed = await ctx.ports.sessions.completeCancelledSession({
      id: session.id,
      now
    });
    if (!completed) {return undefined;}
    return { to: "COMPLETED", reason: "friday_postpone_window_elapsed" };
  }

  // state: 順延期限前は UI cleanup → 順延投票メッセージ送信 → POSTPONE_VOTING へ。
  await emitCancelledUiCleanup(client, ctx, session);
  const channel = await getTextChannel(client, session.channelId);
  const postponeVm = buildPostponeMessageViewModel(session);
  const sent = await channel.send(renderPostponeBody(postponeVm));
  await ctx.ports.sessions.updatePostponeMessageId(session.id, sent.id);
  const transitioned = await ctx.ports.sessions.startPostponeVoting({
    id: session.id,
    now,
    postponeDeadlineAt: postponeDeadline
  });
  if (!transitioned) {return undefined;}
  return { to: "POSTPONE_VOTING", reason: "friday_cancel_resumed" };
};
