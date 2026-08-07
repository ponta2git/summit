import type { AppContext } from "../appContext.js";
import { logger } from "../logger.js";

export interface ReconciledOutboxDeadLetters {
  readonly deadLettersRequeued: number;
  readonly successorsRequeued: number;
}

/** Re-open dead-letter chains only during startup recovery. */
export const reconcileOutboxDeadLetters = async (
  ctx: AppContext
): Promise<ReconciledOutboxDeadLetters> => {
  try {
    const result = await ctx.ports.outbox.requeueFailedChains(ctx.clock.now());
    if (result.deadLettersRequeued > 0 || result.successorsRequeued > 0) {
      logger.warn(
        { event: "reconciler.outbox_dead_letters_requeued", ...result },
        "Reconciler: requeued dead-lettered outbox chains."
      );
    }
    return result;
  } catch (error: unknown) {
    logger.error(
      { error, event: "reconciler.outbox_dead_letters_requeue_failed" },
      "Reconciler: failed to requeue dead-lettered outbox chains."
    );
    return { deadLettersRequeued: 0, successorsRequeued: 0 };
  }
};
