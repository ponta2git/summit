import { okAsync, safeTry } from "neverthrow";

import type { AppContext } from "../appContext.js";
import {
  buildAskBodyIntent,
  buildPostponeVoteIntent,
  OUTBOX_RECOVERY_ORDINALS
} from "../db/repositories/sessionOutboxIntents.js";
import type { EnqueueOutboxInput } from "../db/ports.js";
import type { SessionRow } from "../db/rows.js";
import { fromDatabaseCall } from "../errors/result.js";
import { logger } from "../logger.js";
import {
  runSchedulerBatchResult,
  type SchedulerBatchReport,
  type SchedulerResult
} from "./scheduler.types.js";

const buildMissingMessageIntents = (
  session: SessionRow
): readonly EnqueueOutboxInput[] => {
  if (
    session.status !== "ASKING" &&
    session.status !== "POSTPONE_VOTING" &&
    session.status !== "POSTPONED"
  ) {
    return [];
  }
  const intents: EnqueueOutboxInput[] = [];
  if (!session.askMessageId) {
    intents.push(buildAskBodyIntent(session, OUTBOX_RECOVERY_ORDINALS.ask));
  }
  if (
    !session.postponeMessageId &&
    (session.status === "POSTPONE_VOTING" || session.status === "POSTPONED")
  ) {
    intents.push(buildPostponeVoteIntent(session, OUTBOX_RECOVERY_ORDINALS.postpone));
  }
  return intents;
};

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
    () => ctx.ports.sessions.findNonTerminalSessions(),
    "Failed to find non-terminal sessions for message recovery."
  ).andThen((nonTerminal) =>
    runSchedulerBatchResult(
      "missing_message_intents",
      nonTerminal,
      (session) => safeTry(async function* () {
        let queued = 0;
        for (const intent of buildMissingMessageIntents(session)) {
          const result = yield* fromDatabaseCall(
            () => ctx.ports.outbox.enqueue(intent),
            "Failed to enqueue a missing message intent."
          );
          if (!result.skipped) {
            queued += 1;
            logger.info(
              {
                event: "reconciler.message_intent_queued",
                sessionId: session.id,
                weekKey: session.weekKey,
                renderer: intent.payload.kind === "send_message"
                  ? intent.payload.renderer
                  : undefined
              },
              "Reconciler: queued a missing message delivery intent."
            );
          }
        }
        return okAsync(queued);
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
