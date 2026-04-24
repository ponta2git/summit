import type { AppContext } from "../appContext.js";
import { logger } from "../logger.js";

/**
 * Invariant F: Release IN_FLIGHT outbox rows past their claim deadline.
 *
 * @remarks
 * race: worker が claim 中に crash すると IN_FLIGHT で stuck する。startup/reconnect で
 * PENDING に戻し次 worker tick で再配送させる。
 * @see ADR-0035
 */
export const reconcileOutboxClaims = async (
  ctx: AppContext
): Promise<number> => {
  try {
    const released = await ctx.ports.outbox.releaseExpiredClaims(ctx.clock.now());
    if (released > 0) {
      logger.warn(
        { event: "reconciler.outbox_claim_reclaimed", released },
        "Reconciler: released expired outbox claims."
      );
    }
    return released;
  } catch (error: unknown) {
    logger.error(
      { error, event: "reconciler.outbox_claim_reclaim_failed" },
      "Reconciler: failed to release expired outbox claims."
    );
    return 0;
  }
};
