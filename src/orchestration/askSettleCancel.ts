import type { Client } from "discord.js";
import { type ResultAsync, okAsync, safeTry } from "neverthrow";

import type { AppContext } from "../appContext.js";
import type { AppError } from "../errors/index.js";
import { fromDatabasePromise } from "../errors/result.js";
import type { CancelReason } from "../features/ask-session/cancelReason.js";
import { updateAskMessage } from "../features/ask-session/messageEditor.js";
import { logger } from "../logger.js";

type AskingCancelReason = Extract<CancelReason, "absent" | "deadline_unanswered" | "saturday_cancelled">;

export const reflectAskingCancellation = (
  client: Client,
  ctx: AppContext,
  settled: Parameters<typeof updateAskMessage>[2]
): ResultAsync<void, AppError> =>
  updateAskMessage(client, ctx, settled).andTee(() => {
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
 * @see ADR-0040
 */
export const settleAskingSession = (
  client: Client,
  ctx: AppContext,
  sessionId: string,
  reason: CancelReason
): ResultAsync<void, AppError> =>
  safeTry(async function* () {
    const resolvedReason: AskingCancelReason =
      reason === "absent"
        ? "absent"
        : reason === "saturday_cancelled"
          ? "saturday_cancelled"
          : "deadline_unanswered";
    const result = yield* fromDatabasePromise(
      ctx.ports.sessionCommands.settleAskingCancellation({
        sessionId,
        now: ctx.clock.now(),
        reason: resolvedReason
      }),
      "Failed to settle cancelled ASKING aggregate."
    );
    if (result.kind === "session_not_found") {return okAsync(undefined);}

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
      return okAsync(undefined);
    }
    yield* reflectAskingCancellation(client, ctx, result.session);
    return okAsync(undefined);
  });
