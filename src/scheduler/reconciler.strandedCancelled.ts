import type { Client } from "discord.js";

import type { AppContext } from "../appContext.js";
import type { SessionRow } from "../db/rows.js";
import { updateAskMessage } from "../features/ask-session/messageEditor.js";
import type { SettleCancelReason } from "../features/ask-session/messages.js";
import { logger } from "../logger.js";

/**
 * Invariant A: Promote stranded CANCELLED sessions to their next canonical state.
 *
 * @remarks
 * state: CANCELLED は短命中間状態 (ADR-0001)。crash 等で宙づり行が残った場合に収束させる。
 * 土曜 (postponeCount=1) は COMPLETED、金曜は順延期限前なら POSTPONE_VOTING、期限後は COMPLETED。
 * CANCELLED→SKIPPED は許可遷移に無いため終端は COMPLETED を採用する。
 * @see ADR-0051
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

const promoteStranded = async (
  client: Client,
  ctx: AppContext,
  session: SessionRow,
  now: Date
): Promise<{ readonly to: "POSTPONE_VOTING" | "COMPLETED"; readonly reason: string } | undefined> => {
  const result = await ctx.ports.sessionCommands.settleAskingCancellation({
    sessionId: session.id,
    now,
    reason: resolveSettleCancelReason(session)
  });
  if (result.kind !== "transitioned") {return undefined;}
  await updateAskMessage(client, ctx, result.session);
  if (result.session.status === "POSTPONE_VOTING") {
    return { to: "POSTPONE_VOTING", reason: "friday_cancel_resumed" };
  }
  return {
    to: "COMPLETED",
    reason:
      session.postponeCount === 1
        ? "saturday_cancelled_stranded"
        : "friday_postpone_window_elapsed"
  };
};
