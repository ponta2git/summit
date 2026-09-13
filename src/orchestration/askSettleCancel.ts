import type { Client } from "discord.js";
import * as Effect from "effect/Effect";

import type { AppContext } from "../appContext.ts";
import type { SessionRow } from "../db/rows.ts";
import type { AppError } from "../errors/index.ts";
import { fromDatabaseCall } from "../errors/effect.ts";
import type { CancelReason } from "../features/ask-session/cancelReason.ts";
import { updateAskMessage } from "../features/ask-session/messageEditor.ts";
import { logger } from "../logger.ts";

type AskingCancelReason = Extract<CancelReason, "absent" | "deadline_unanswered" | "saturday_cancelled">;

export const reflectAskingCancellation = (
  client: Client,
  ctx: AppContext,
  settled: SessionRow
): Effect.Effect<void, AppError> =>
  Effect.gen(function* () {
    yield* updateAskMessage(client, ctx, settled);
    logger.info(
      {
        sessionId: settled.id,
        weekKey: settled.weekKey,
        from: "ASKING",
        to: settled.status,
        reason: settled.cancelReason,
        delivery: "outbox"
      },
      "Asking cancellation settled."
    );
  });

/**
 * Settles an ASKING session into the cancelled path, including saturday completion
 * or postpone-voting initialization.
 *
 * @remarks
 * state: ASKING → CANCELLED → canonical state を一つの aggregate transaction で収束させる。
 * source-of-truth: settle / postpone の新規投稿は同 transaction の ordered outbox intent。
 *   この関数は既存 ask message の再描画だけを best-effort で行う。
 */
export const settleAskingSession = (
  client: Client,
  ctx: AppContext,
  sessionId: string,
  reason: CancelReason
): Effect.Effect<void, AppError> =>
  Effect.gen(function* () {
    const resolvedReason: AskingCancelReason =
      reason === "absent"
        ? "absent"
        : reason === "saturday_cancelled"
          ? "saturday_cancelled"
          : "deadline_unanswered";
    const result = yield* fromDatabaseCall(
      () => ctx.ports.sessionCommands.settleAskingCancellation({
        sessionId,
        now: ctx.clock.now(),
        reason: resolvedReason
      }),
      "Failed to settle cancelled ASKING aggregate."
    );
    if (result.kind === "session_not_found") {return;}

    if (result.kind === "closed") {
      logger.info(
        {
          sessionId,
          weekKey: result.session.weekKey,
          status: result.session.status,
          reason: "closed status, skip settle"
        },
        "settleAskingSession called on an already settled session; skipping."
      );
      return;
    }
    yield* reflectAskingCancellation(client, ctx, result.session);
  });
