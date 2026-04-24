import type { AppContext } from "../appContext.js";
import {
  OUTBOX_RETENTION_DELIVERED_MS,
  OUTBOX_RETENTION_FAILED_MS
} from "../config.js";
import { logger } from "../logger.js";

/**
 * Prune terminal outbox rows past their retention deadline.
 *
 * @remarks
 * idempotent: 削除のみで状態遷移なし。同一 tick の重複呼び出しに安全。
 * invariant: PENDING / IN_FLIGHT は repository 側で除外済 (ADR-0042)。
 * @see ADR-0042
 */
export const runOutboxRetentionTick = async (ctx: AppContext): Promise<void> => {
  const now = ctx.clock.now();
  const deliveredOlderThan = new Date(now.getTime() - OUTBOX_RETENTION_DELIVERED_MS);
  const failedOlderThan = new Date(now.getTime() - OUTBOX_RETENTION_FAILED_MS);
  try {
    const result = await ctx.ports.outbox.prune({
      deliveredOlderThan,
      failedOlderThan
    });
    if (result.deliveredPruned > 0 || result.failedPruned > 0) {
      logger.info(
        {
          event: "outbox.retention_pruned",
          deliveredPruned: result.deliveredPruned,
          failedPruned: result.failedPruned
        },
        "Outbox retention: pruned terminal rows."
      );
    }
  } catch (error: unknown) {
    logger.error(
      { error, event: "outbox.retention_failed" },
      "Outbox retention: prune failed."
    );
  }
};
