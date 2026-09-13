import * as Effect from "effect/Effect";
import type { AppContext } from "../appContext.ts";
import { fromDatabaseCall } from "../errors/effect.ts";
import { logger } from "../logger.ts";
import type { SchedulerEffect } from "./scheduler.types.ts";

/**
 * Invariant F: Release IN_FLIGHT outbox rows past their claim deadline.
 *
 * @remarks
 * race: worker が claim 中に crash すると IN_FLIGHT で stuck する。startup/reconnect で
 * PENDING に戻し次 worker tick で再配送させる。
 */
export const reconcileOutboxClaims = (
  ctx: AppContext
): SchedulerEffect<number> =>
  Effect.tap(fromDatabaseCall(
    () => ctx.ports.outbox.releaseExpiredClaims(ctx.clock.now()),
    "Failed to release expired outbox claims."
  ), (released) => Effect.sync(() => {
    if (released > 0) {
      logger.warn(
        { event: "reconciler.outbox_claim_reclaimed", released },
        "Reconciler: released expired outbox claims."
      );
    }
  }));
