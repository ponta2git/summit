import type { Logger } from "pino";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type { ClaimedResultNotification } from "../../db/ports.resultNotifications.ts";
import { RESULT_NOTIFICATION_RECOVERY_BACKOFF_MS, SCHEDULER_MIN_TIMER_DELAY_MS,
  NOTIFICATION_PENDING_WARN_AFTER_MS, NOTIFICATION_PENDING_WARNING_INTERVAL_MS } from "../../config.ts";
import { catchExpectedError, runPromiseBoundary } from "../../runtime/effect.ts";
import type { Clock } from "../../time/index.ts";
import { createDeliveryCapacity } from "./capacity.ts";
import { deliveryLanes } from "./lanes.ts";
import { prepareDeliveryTask, type DeliveryTask } from "./contracts.ts";
import type { ResultDeliverySource } from "./sources/result.ts";
import type { DeliveryRuntime } from "./runtime.ts";
import type { ResultIoLedger } from "./resultIo.ts";

/** Refill result deliveries on completion; capacity accounting never selects notification kinds. */
export const createResultDeliveryRuntime = <E>(deps: {
  readonly source: ResultDeliverySource;
  readonly clock: Clock;
  readonly prepareTask: (entry: ClaimedResultNotification, consumeYieldRequest: () => boolean) => DeliveryTask<E>;
  readonly logger: Pick<Logger, "info" | "warn" | "error">;
  readonly io: ResultIoLedger;
}): DeliveryRuntime => {
  const { source, logger } = deps;
  const observe = (report: () => void): void => {
    try { report(); } catch { /* Diagnostics must not prevent wake, recovery or settlement. */ }
  };
  const capacity = createDeliveryCapacity({ ...deliveryLanes.results,
    retained: deps.io.reservations,
    onSettled: (notificationId, exit) => {
      try { if (Exit.isFailure(exit)) { observe(() => logger.error({ event: "result_notification.dispatch_failed", notificationId })); } }
      finally { dispatcher.wake("delivery_finished"); }
    }
  });
  let timer: { readonly handle: ReturnType<typeof setTimeout>; readonly dueAt: number } | undefined;
  let pumping: Promise<void> | undefined;
  let queued = false;
  let recoveryAttempt = 0;
  let recoveryDueAt = 0;
  let pumpMonitor: ReturnType<typeof setTimeout> | undefined;
  let pumpStartedAt = 0;
  let pumpPhase: "claim" | "next_dispatch" = "claim";
  const monitorPump = (): void => {
    if (!pumping) { return; }
    observe(() => logger.warn({ event: "result_notification.database_pending", phase: pumpPhase,
      elapsedMs: performance.now() - pumpStartedAt }));
    pumpMonitor = setTimeout(monitorPump, NOTIFICATION_PENDING_WARNING_INTERVAL_MS);
    pumpMonitor.unref();
  };
  const schedule = (delay: number): void => {
    if (capacity.isStopping()) { return; }
    const boundedDelay = Math.max(0, Math.min(Math.max(delay, recoveryDueAt - performance.now()), 2_147_483_647));
    const dueAt = performance.now() + boundedDelay;
    // invariant: wake は既存期限を延期せず、障害backoffも短縮しない。
    if (timer && timer.dueAt <= dueAt) { return; }
    clearTimeout(timer?.handle);
    timer = { dueAt, handle: setTimeout(() => { timer = undefined; void pump(); }, boundedDelay) };
  };
  const prepare = (entry: ClaimedResultNotification): DeliveryTask<E> => {
    const consumeYieldRequest = source.claimed(entry);
    return prepareDeliveryTask(entry, () => deps.prepareTask(entry, consumeYieldRequest));
  };
  const startBatch = (batch: readonly ClaimedResultNotification[]): Effect.Effect<void> => {
    if (capacity.isStopping()) { return Effect.void; }
    // why: 同期でraw payloadを切り離す。非同期forkにはplanとmetadataだけを渡す。
    const deliveries = batch.map(prepare);
    return Effect.asVoid(Effect.forEach(deliveries, item => Effect.suspend(() =>
      capacity.isStopping() ? Effect.void : capacity.start(item.id, item.payloadBytes, item.run))));
  };
  const pumpWork = Effect.gen(function* () {
    const available = capacity.snapshot();
    if (available.slots <= 0 || available.payloadBytes <= 0) { return; }
    const claimStartedAt = deps.clock.now();
    yield* source.claim(available).pipe(Effect.flatMap(startBatch));
    if (capacity.isStopping()) { return; }
    const remaining = capacity.snapshot();
    if (remaining.slots > 0 && remaining.payloadBytes > 0) {
      pumpPhase = "next_dispatch";
      const next = yield* source.nextDispatchAt(remaining.activeIds);
      // invariant: 容量待ちのdue通知は完了wakeで再開し、同じ通知をpollしない。
      if (next !== null && (remaining.activeIds.length === 0 || next > claimStartedAt)) {
        schedule(Math.max(SCHEDULER_MIN_TIMER_DELAY_MS, next.getTime() - deps.clock.now().getTime()));
      }
    }
    recoveryAttempt = 0;
    recoveryDueAt = 0;
  });
  const pump = (): Promise<void> => {
    if (capacity.isStopping()) { return Promise.resolve(); }
    if (pumping) { queued = true; return pumping; }
    queued = false;
    pumpStartedAt = performance.now(); pumpPhase = "claim";
    pumpMonitor = setTimeout(monitorPump, NOTIFICATION_PENDING_WARN_AFTER_MS); pumpMonitor.unref();
    const work = catchExpectedError(pumpWork, () => Effect.sync(() => {
      const attempt = recoveryAttempt;
      const delay = RESULT_NOTIFICATION_RECOVERY_BACKOFF_MS[recoveryAttempt++];
      queued = false;
      recoveryDueAt = delay === undefined ? 0 : performance.now() + delay;
      if (delay !== undefined) { schedule(delay); }
      observe(() => logger.warn({ event: "result_notification.dispatch_unavailable", recoveryAttempt: attempt }));
    }));
    // 外部timerの境界だけでPromiseへ変換。個別配送はcapacityのScope内に残す。
    pumping = runPromiseBoundary(work).catch(() => { observe(() => logger.error({ event: "result_notification.dispatch_failed" })); })
      .finally(() => {
        clearTimeout(pumpMonitor); pumpMonitor = undefined;
        pumping = undefined;
        if (queued && !capacity.isStopping()) { schedule(0); }
      });
    return pumping;
  };
  const dispatcher: DeliveryRuntime = {
    wake: reason => {
      if (capacity.isStopping()) { return; }
      queued = true;
      source.wake(reason);
      observe(() => logger.info({ event: "result_notification.wake", reason }));
      if (!pumping) { schedule(0); }
    },
    stop: () => { capacity.stop(); deps.io.stop(); clearTimeout(timer?.handle); timer = undefined; },
    drain: async () => {
      const deliveries = async (): Promise<void> => { await pumping; await runPromiseBoundary(capacity.drain()); };
      await Promise.all([deliveries(), deps.io.drain()]);
      // A delivery may have started a later SDK operation after the first drain snapshot.
      await deps.io.drain();
      if (capacity.isStopping()) { await runPromiseBoundary(capacity.close()); }
    }
  };
  return dispatcher;
};
