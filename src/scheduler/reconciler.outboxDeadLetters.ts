import type { AppContext } from "../appContext.js";
import { fromDatabaseCall } from "../errors/result.js";
import { logger } from "../logger.js";
import type { SchedulerResult } from "./scheduler.types.js";

export interface ReconciledOutboxDeadLetters {
  readonly deadLettersRequeued: number;
  readonly successorsRequeued: number;
}

/** Re-open dead-letter chains only during startup recovery. */
export const reconcileOutboxDeadLetters = (
  ctx: AppContext
): SchedulerResult<ReconciledOutboxDeadLetters> =>
  fromDatabaseCall(
    () => ctx.ports.outbox.requeueFailedChains(ctx.clock.now()),
    "Failed to requeue dead-lettered outbox chains."
  ).andTee((result) => {
    if (result.deadLettersRequeued > 0 || result.successorsRequeued > 0) {
      logger.warn(
        { event: "reconciler.outbox_dead_letters_requeued", ...result },
        "Reconciler: requeued dead-lettered outbox chains."
      );
    }
  });
