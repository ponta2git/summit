import type { AppContext } from "../appContext.js";
import {
  OUTBOX_METRICS_PENDING_AGE_WARN_MS,
  OUTBOX_METRICS_PENDING_WARN_DEPTH
} from "../config.js";
import { logger } from "../logger.js";
import { fromDatabaseCall } from "../errors/result.js";
import type { SchedulerResult } from "./scheduler.types.js";

/**
 * Snapshot outbox depth/age and emit a structured log line for observability.
 *
 * @remarks
 * idempotent: read-only snapshot。warn 昇格は OR 条件 (failed>0 / pending>threshold /
 *   oldestPendingAgeMs>threshold) で評価する。失敗は呼び出し側 tick safety に閉じ込めず
 *   ローカル try/catch で吸収して他 tick への波及を防ぐ。
 * @see ADR-0043
 */
export const runOutboxMetricsTick = (ctx: AppContext): SchedulerResult<{
  readonly pending: number;
  readonly inFlight: number;
  readonly failed: number;
  readonly oldestPendingAgeMs: number | null;
  readonly oldestFailedAgeMs: number | null;
}> => {
  const now = ctx.clock.now();
  return fromDatabaseCall(
    () => ctx.ports.outbox.getMetrics(now),
    "Failed to read outbox metrics."
  ).andTee((m) => {
    const isWarn =
      m.failed > 0 ||
      m.pending > OUTBOX_METRICS_PENDING_WARN_DEPTH ||
      (m.oldestPendingAgeMs !== null &&
        m.oldestPendingAgeMs > OUTBOX_METRICS_PENDING_AGE_WARN_MS);
    const fields = {
      event: "outbox.metrics",
      pending: m.pending,
      inFlight: m.inFlight,
      failed: m.failed,
      oldestPendingAgeMs: m.oldestPendingAgeMs,
      oldestFailedAgeMs: m.oldestFailedAgeMs
    };
    if (isWarn) {
      logger.warn(fields, "Outbox metrics: warn threshold exceeded.");
    } else {
      logger.info(fields, "Outbox metrics.");
    }
  });
};
