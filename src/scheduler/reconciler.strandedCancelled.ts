import * as Effect from "effect/Effect";
import type { Client } from "discord.js";

import type { AppContext } from "../appContext.ts";
import type { SessionRow } from "../db/rows.ts";
import { fromDatabaseCall } from "../errors/effect.ts";
import { updateAskMessage } from "../features/ask-session/messageEditor.ts";
import type { SettleCancelReason } from "../features/ask-session/messages.ts";
import { logger } from "../logger.ts";
import {
  runSchedulerBatchEffect,
  type SchedulerBatchReport,
  type SchedulerEffect
} from "./scheduler.types.ts";

/**
 * Invariant A: Promote stranded CANCELLED sessions to their next canonical state.
 *
 * @remarks
 * state: CANCELLED は短命中間状態。crash 等で宙づり行が残った場合に収束させる。
 * 土曜 (postponeCount=1) は COMPLETED、金曜は順延期限前なら POSTPONE_VOTING、期限後は COMPLETED。
 * CANCELLED→SKIPPED は許可遷移に無いため終端は COMPLETED を採用する。
 */
export const reconcileStrandedCancelled = (
  client: Client,
  ctx: AppContext
): SchedulerEffect<SchedulerBatchReport> =>
  Effect.flatMap(fromDatabaseCall(
    () => ctx.ports.sessions.findStrandedCancelledSessions(),
    "Failed to find stranded CANCELLED sessions."
  ), (stranded) =>
    runSchedulerBatchEffect(
      "stranded_cancelled",
      stranded,
      (session) => promoteStranded(client, ctx, session, ctx.clock.now()),
      (session) => ({ sessionId: session.id, weekKey: session.weekKey }),
      (failure) => {
        logger.error(
          {
            error: failure.error,
            errorCode: failure.error.code,
            event: "reconciler.cancelled_promoted_failed",
            sessionId: failure.sessionId,
            weekKey: failure.weekKey
          },
          "Reconciler: failed to promote stranded CANCELLED session."
        );
      },
      (result) => result === undefined ? 0 : 1
    ));

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

const promoteStranded = (
  client: Client,
  ctx: AppContext,
  session: SessionRow,
  now: Date
): SchedulerEffect<
  { readonly to: "POSTPONE_VOTING" | "COMPLETED"; readonly reason: string } | undefined
> =>
  Effect.flatMap(fromDatabaseCall(
    () => ctx.ports.sessionCommands.settleAskingCancellation({
      sessionId: session.id,
      now,
      reason: resolveSettleCancelReason(session)
    }),
    "Failed to settle stranded CANCELLED session."
  ), (result) => {
    if (result.kind !== "transitioned") {return Effect.succeed(undefined);}
    return Effect.map(updateAskMessage(client, ctx, result.session), () => {
      const next = result.session.status === "POSTPONE_VOTING"
        ? { to: "POSTPONE_VOTING" as const, reason: "friday_cancel_resumed" }
        : {
            to: "COMPLETED" as const,
            reason: session.postponeCount === 1
              ? "saturday_cancelled_stranded"
              : "friday_postpone_window_elapsed"
          };
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
      return next;
    });
  });
