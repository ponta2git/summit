import type { AppContext } from "../appContext.js";
import {
  OUTBOX_RETENTION_DELIVERED_MS,
  OUTBOX_RETENTION_FAILED_MS
} from "../config.js";
import { logger } from "../logger.js";
import { subMs } from "../time/index.js";
import { fromDatabaseCall } from "../errors/result.js";
import type { SchedulerResult } from "./scheduler.types.js";

/**
 * Prune terminal outbox rows past their retention deadline.
 *
 * @remarks
 * idempotent: 削除のみで状態遷移なし。同一 tick の重複呼び出しに安全。
 * invariant: PENDING / IN_FLIGHT は repository 側で除外済 (ADR-0042)。
 * @see ADR-0042
 */
export const runOutboxRetentionTick = (ctx: AppContext): SchedulerResult<{
  readonly deliveredPruned: number;
  readonly failedPruned: number;
  readonly cancelledPruned: number;
}> => {
  const now = ctx.clock.now();
  const deliveredOlderThan = subMs(now, OUTBOX_RETENTION_DELIVERED_MS);
  const failedOlderThan = subMs(now, OUTBOX_RETENTION_FAILED_MS);
  return fromDatabaseCall(
    () => ctx.ports.outbox.prune({
      deliveredOlderThan,
      failedOlderThan
    }),
    "Failed to prune outbox rows."
  ).andTee((result) => {
    if (
      result.deliveredPruned > 0 ||
      result.failedPruned > 0 ||
      result.cancelledPruned > 0
    ) {
      logger.info(
        {
          event: "outbox.retention_pruned",
          deliveredPruned: result.deliveredPruned,
          failedPruned: result.failedPruned,
          cancelledPruned: result.cancelledPruned
        },
        "Outbox retention: pruned terminal rows."
      );
    }
  });
};
