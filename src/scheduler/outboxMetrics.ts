import * as Effect from "effect/Effect"; // skipcq: JS-C1003
import type { AppContext } from "../appContext.ts";
import {
  OUTBOX_METRICS_PENDING_AGE_WARN_MS,
  OUTBOX_METRICS_PENDING_WARN_DEPTH
} from "../config.ts";
import { logger } from "../logger.ts";
import { fromDatabaseCall } from "../errors/effect.ts";
import type { SchedulerEffect } from "./scheduler.types.ts";

/**
 * Snapshot outbox depth/age and emit a structured log line for observability.
 *
 * @remarks
 * idempotent: read-only snapshot。warn 昇格は OR 条件 (failed>0 / pending>threshold /
 *   oldestPendingAgeMs>threshold) で評価する。DB failure は Effect で runtime boundary に
 *   返し、他 tick への波及は `runEffectTickSafely` が防ぐ。
 */
export const runOutboxMetricsTick = (ctx: AppContext): SchedulerEffect<{
  readonly pending: number;
  readonly inFlight: number;
  readonly failed: number;
  readonly oldestPendingAgeMs: number | null;
  readonly oldestFailedAgeMs: number | null;
}> => Effect.suspend(() => {
  const now = ctx.clock.now();
  return Effect.tap(fromDatabaseCall(
    () => ctx.ports.outbox.getMetrics(now),
    "Failed to read outbox metrics."
  ), (metrics) => Effect.sync(() => {
    const isWarn =
      metrics.failed > 0 ||
      metrics.pending > OUTBOX_METRICS_PENDING_WARN_DEPTH ||
      (metrics.oldestPendingAgeMs !== null &&
        metrics.oldestPendingAgeMs > OUTBOX_METRICS_PENDING_AGE_WARN_MS);
    const fields = {
      event: "outbox.metrics",
      pending: metrics.pending,
      inFlight: metrics.inFlight,
      failed: metrics.failed,
      oldestPendingAgeMs: metrics.oldestPendingAgeMs,
      oldestFailedAgeMs: metrics.oldestFailedAgeMs
    };
    if (isWarn) {
      logger.warn(fields, "Outbox metrics: warn threshold exceeded.");
    } else {
      logger.info(fields, "Outbox metrics.");
    }
  }));
});
