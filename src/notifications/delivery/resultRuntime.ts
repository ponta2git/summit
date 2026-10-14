import type { Logger } from "pino";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type { ClaimedResultNotification } from "../../db/ports.resultNotifications.ts";
import { RESULT_NOTIFICATION_RECOVERY_BACKOFF_MS, SCHEDULER_MIN_TIMER_DELAY_MS } from "../../config.ts";
import { catchExpectedError, runPromiseBoundary } from "../../runtime/effect.ts";
import type { Clock } from "../../time/index.ts";
import { createDeliveryCapacity } from "./capacity.ts";
import { deliveryLanes } from "./lanes.ts";
import { prepareDeliveryTask, type DeliveryTask } from "./contracts.ts";
import type { ResultDeliverySource } from "./sources/result.ts";
import type { DeliveryRuntime } from "./runtime.ts";

/** Refill result deliveries on completion; capacity accounting never selects notification kinds. */
export const createResultDeliveryRuntime = <E>(deps: {
  readonly source: ResultDeliverySource;
  readonly clock: Clock;
  readonly prepareTask: (entry: ClaimedResultNotification, consumeYieldRequest: () => boolean) => DeliveryTask<E>;
  readonly logger: Pick<Logger, "info" | "warn" | "error">;
}): DeliveryRuntime => {
  const { source, logger } = deps;
  const capacity = createDeliveryCapacity({ laneId: "results", ...deliveryLanes.results,
    onSettled: (notificationId, exit) => {
      if (Exit.isFailure(exit)) { logger.error({ event: "result_notification.dispatch_failed", notificationId }); }
      dispatcher.wake("delivery_finished");
    }
  });
  let timer: { readonly handle: ReturnType<typeof setTimeout>; readonly dueAt: number } | undefined;
  let pumping: Promise<void> | undefined;
  let queued = false;
  let recoveryAttempt = 0;
  let recoveryDueAt = 0;
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
    yield* source.claim(available).pipe(Effect.flatMap(startBatch));
    if (capacity.isStopping()) { return; }
    const remaining = capacity.snapshot();
    if (remaining.slots > 0 && remaining.payloadBytes > 0) {
      const next = yield* source.nextDispatchAt(remaining.activeIds);
      // invariant: 容量待ちのdue通知は完了wakeで再開し、同じ通知をpollしない。
      if (next !== null && (remaining.activeIds.length === 0 || next > deps.clock.now())) {
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
    const work = catchExpectedError(pumpWork, () => Effect.sync(() => {
      logger.warn({ event: "result_notification.dispatch_unavailable", recoveryAttempt });
      const delay = RESULT_NOTIFICATION_RECOVERY_BACKOFF_MS[recoveryAttempt++];
      queued = false;
      recoveryDueAt = delay === undefined ? 0 : performance.now() + delay;
      if (delay !== undefined) { schedule(delay); }
    }));
    // 外部timerの境界だけでPromiseへ変換。個別配送はcapacityのScope内に残す。
    pumping = runPromiseBoundary(work).catch(() => { logger.error({ event: "result_notification.dispatch_failed" }); })
      .finally(() => {
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
      logger.info({ event: "result_notification.wake", reason });
      if (!pumping) { schedule(0); }
    },
    stop: () => { capacity.stop(); clearTimeout(timer?.handle); timer = undefined; },
    drain: async () => {
      await pumping;
      await runPromiseBoundary(capacity.drain());
      if (capacity.isStopping()) { await runPromiseBoundary(capacity.close()); }
    }
  };
  return dispatcher;
};
