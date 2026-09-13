import { okAsync, safeTry } from "neverthrow";

import type { AppContext } from "../appContext.ts";
import { fromDatabaseCall } from "../errors/result.ts";
import { logger } from "../logger.ts";
import {
  runSchedulerBatchResult,
  type SchedulerBatchReport,
  type SchedulerResult
} from "./scheduler.types.ts";

/**
 * Invariant C: ensure every missing non-terminal message has a durable delivery intent.
 *
 * @remarks
 * Recovery uses the same outbox as normal publication. This avoids a startup direct-send racing
 * the original pending intent and producing two Discord messages. Reserved tail ordinals place a
 * legacy repair after existing intents in the current revision and before any future revision.
 */
export const reconcileMissingMessageIntents = (
  ctx: AppContext
): SchedulerResult<SchedulerBatchReport> =>
  fromDatabaseCall(
    () => ctx.ports.sessions.findMessageRecoveryCandidates(),
    "Failed to find message recovery candidates."
  ).andThen((nonTerminal) =>
    runSchedulerBatchResult(
      "missing_message_intents",
      nonTerminal,
      (session) => safeTry(async function* () {
        const queued = yield* fromDatabaseCall(
          () => ctx.ports.sessionCommands.recoverMissingMessageIntents(session.id),
          "Failed to recover missing message intents."
        );
        for (const intent of queued) {
          logger.info({ event: "reconciler.message_intent_queued", sessionId: session.id,
            weekKey: session.weekKey, renderer: intent.payload.renderer },
          "Reconciler: queued a missing message delivery intent.");
        }
        return okAsync(queued.length);
      }),
      (session) => ({ sessionId: session.id, weekKey: session.weekKey }),
      (failure) => {
        logger.error(
          {
            error: failure.error,
            errorCode: failure.error.code,
            event: "reconciler.message_intent_queue_failed",
            sessionId: failure.sessionId,
            weekKey: failure.weekKey
          },
          "Reconciler: failed to queue a missing message delivery intent."
        );
      },
      (queued) => queued
    )
  );
