import type { ResultNotificationKind } from "@momo/db";
import type { Client } from "discord.js";
import type { Logger } from "pino";
import { OUTBOX_CLAIM_DURATION_MS, RESULT_NOTIFICATION_CONCURRENCY, RESULT_NOTIFICATION_RECOVERY_BACKOFF_MS,
  RESULT_NOTIFICATION_CLAIM_BUDGET_BYTES, SCHEDULER_MIN_TIMER_DELAY_MS } from "../config.ts";
import type { ClaimedResultNotification, ResultDeliveryContext, ResultNotificationsPort } from "../db/ports.resultNotifications.ts";
import { logger as defaultLogger } from "../logger.ts";
import type { Clock } from "../time/index.ts";
import { deliverResultNotification } from "./resultNotifications.delivery.ts";

export interface ResultNotificationDispatcher {
  wake(reason: string): void;
  stop(): void;
  drain(): Promise<void>;
}

/** Event-driven dispatch bounded by concurrent deliveries and retained payload bytes. */
export const createResultNotificationDispatcher = (deps: {
  readonly client: Client;
  readonly port: ResultNotificationsPort;
  readonly clock: Clock;
  readonly context: ResultDeliveryContext;
  readonly logger?: Pick<Logger, "info" | "warn" | "error">;
}): ResultNotificationDispatcher => {
  const logger = deps.logger ?? defaultLogger;
  const active = new Map<string, Promise<void>>();
  let activePayloadBytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timerDueAt: number | undefined;
  let pumping: Promise<void> | undefined;
  let queued = false;
  let stopped = false;
  let recoveryAttempt = 0;
  let recoveryDueAt = 0;
  let preferredKind: ResultNotificationKind = "ocr_completed";
  let wakeGeneration = 0;
  const deliveryDeps = { ...deps, logger, isStopping: () => stopped };
  const schedule = (delay: number): void => {
    if (stopped) { return; }
    const boundedDelay = Math.max(0, Math.min(Math.max(delay, recoveryDueAt - performance.now()), 2_147_483_647));
    const dueAt = performance.now() + boundedDelay;
    // invariant: 新しい wake は既存の起動期限を遅らせない。継続的な受付でも配送を開始する。
    if (timer !== undefined && timerDueAt !== undefined && timerDueAt <= dueAt) { return; }
    clearTimeout(timer);
    timerDueAt = dueAt;
    timer = setTimeout(() => { timer = undefined; timerDueAt = undefined; void pump(); }, boundedDelay);
  };
  const trackDelivery = (notificationId: string, payloadBytes: number, work: Promise<void>): void => {
    const delivery = work.catch(() => { logger.error({ event: "result_notification.dispatch_failed", notificationId }); })
      .finally(() => { active.delete(notificationId); activePayloadBytes -= payloadBytes; dispatcher.wake("delivery_finished"); });
    active.set(notificationId, delivery);
  };
  const startBatch = (batch: readonly ClaimedResultNotification[]): void => {
    if (stopped) { return; }
    for (const entry of batch) {
      activePayloadBytes += entry.payloadBytes;
      preferredKind = entry.kind === "ocr_completed" ? "analysis_completed" : "ocr_completed";
      const oversized = entry.payloadBytes > RESULT_NOTIFICATION_CLAIM_BUDGET_BYTES;
      let checkedGeneration = -1;
      const shouldYield = (): boolean => {
        if (oversized || checkedGeneration === wakeGeneration) { return false; }
        checkedGeneration = wakeGeneration;
        return true;
      };
      trackDelivery(entry.id, entry.payloadBytes, deliverResultNotification({ ...deliveryDeps, shouldYield }, entry));
    }
  };
  const pump = (): Promise<void> => {
    if (stopped) { return Promise.resolve(); }
    if (pumping) { queued = true; return pumping; }
    queued = false;
    pumping = (async () => {
      try {
        const capacity = RESULT_NOTIFICATION_CONCURRENCY - active.size;
        const payloadBudgetBytes = RESULT_NOTIFICATION_CLAIM_BUDGET_BYTES - activePayloadBytes;
        if (capacity <= 0 || payloadBudgetBytes <= 0) { return; }
        // why: batch と raw payload は同期処理へ渡し、次の DB 待機や配送 callback に保持しない。
        startBatch(await deps.port.claim({ limit: capacity, now: deps.clock.now(), claimDurationMs: OUTBOX_CLAIM_DURATION_MS,
          excludeIds: [...active.keys()], payloadBudgetBytes, allowOversizedPayload: active.size === 0, preferredKind }));
        if (stopped) { return; }
        if (active.size < RESULT_NOTIFICATION_CONCURRENCY && activePayloadBytes < RESULT_NOTIFICATION_CLAIM_BUDGET_BYTES) {
          const next = await deps.port.getNextDispatchAt([...active.keys()]);
          // A due item may be waiting for the remaining byte budget. Completion
          // wakes us; polling that same item would spin while a delivery is slow.
          if (next !== null && (active.size === 0 || next > deps.clock.now())) {
            schedule(Math.max(SCHEDULER_MIN_TIMER_DELAY_MS, next.getTime() - deps.clock.now().getTime()));
          }
        }
        // invariant: 次回時刻の取得まで成功して初めて、DB 障害の連続回数を戻す。
        recoveryAttempt = 0;
        recoveryDueAt = 0;
      } catch {
        logger.warn({ event: "result_notification.dispatch_unavailable", recoveryAttempt });
        const delay = RESULT_NOTIFICATION_RECOVERY_BACKOFF_MS[recoveryAttempt++];
        // invariant: 処理中の wake は障害 backoff を即時 retry へ上書きしない。
        queued = false;
        recoveryDueAt = delay === undefined ? 0 : performance.now() + delay;
        if (delay !== undefined) { schedule(delay); }
      }
    })().finally(() => {
      pumping = undefined;
      if (queued && !stopped) { schedule(0); }
    });
    return pumping;
  };
  const dispatcher: ResultNotificationDispatcher = {
    wake: reason => {
      if (stopped) { return; }
      queued = true;
      if (reason !== "delivery_finished") { wakeGeneration += 1; }
      logger.info({ event: "result_notification.wake", reason });
      if (!pumping) { schedule(0); }
    },
    stop: () => { stopped = true; clearTimeout(timer); timer = undefined; timerDueAt = undefined; },
    drain: async () => { await pumping; await Promise.all(active.values()); }
  };
  return dispatcher;
};
