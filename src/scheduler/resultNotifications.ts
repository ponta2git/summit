import type { Client } from "discord.js";
import type { Logger } from "pino";
import { OUTBOX_CLAIM_DURATION_MS, RESULT_NOTIFICATION_CONCURRENCY, RESULT_NOTIFICATION_RECOVERY_BACKOFF_MS,
  SCHEDULER_MIN_TIMER_DELAY_MS, SCHEDULER_WAKE_DEBOUNCE_MS } from "../config.ts";
import type { ResultDeliveryContext, ResultNotificationsPort } from "../db/ports.resultNotifications.ts";
import { logger as defaultLogger } from "../logger.ts";
import type { Clock } from "../time/index.ts";
import { deliverResultNotification } from "./resultNotifications.delivery.ts";

export interface ResultNotificationDispatcher {
  wake(reason: string): void;
  stop(): void;
  drain(): Promise<void>;
}

/** Event-driven, bounded dispatch; a slow result never occupies every available slot. */
export const createResultNotificationDispatcher = (deps: {
  readonly client: Client;
  readonly port: ResultNotificationsPort;
  readonly clock: Clock;
  readonly context: ResultDeliveryContext;
  readonly logger?: Pick<Logger, "info" | "warn" | "error">;
}): ResultNotificationDispatcher => {
  const logger = deps.logger ?? defaultLogger;
  const active = new Map<string, Promise<void>>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pumping: Promise<void> | undefined;
  let queued = false;
  let stopped = false;
  let recoveryAttempt = 0;
  const schedule = (delay: number): void => {
    clearTimeout(timer);
    if (stopped) { return; }
    timer = setTimeout(() => { timer = undefined; void pump(); }, Math.min(delay, 2_147_483_647));
  };
  const pump = (): Promise<void> => {
    if (stopped) { return Promise.resolve(); }
    if (pumping) { queued = true; return pumping; }
    queued = false;
    pumping = (async () => {
      try {
        const capacity = RESULT_NOTIFICATION_CONCURRENCY - active.size;
        if (capacity <= 0) { return; }
        const batch = await deps.port.claim({ limit: capacity, now: deps.clock.now(), claimDurationMs: OUTBOX_CLAIM_DURATION_MS,
          excludeIds: [...active.keys()] });
        if (stopped) { return; }
        for (const entry of batch) {
          const delivery = deliverResultNotification({ ...deps, logger, isStopping: () => stopped }, entry)
            .catch(() => { logger.error({ event: "result_notification.dispatch_failed", notificationId: entry.id }); })
            .finally(() => { active.delete(entry.id); dispatcher.wake("delivery_finished"); });
          active.set(entry.id, delivery);
        }
        if (active.size < RESULT_NOTIFICATION_CONCURRENCY) {
          const next = await deps.port.getNextDispatchAt([...active.keys()]);
          if (next !== null) { schedule(Math.max(SCHEDULER_MIN_TIMER_DELAY_MS, next.getTime() - deps.clock.now().getTime())); }
        }
        // invariant: 次回時刻の取得まで成功して初めて、DB 障害の連続回数を戻す。
        recoveryAttempt = 0;
      } catch {
        logger.warn({ event: "result_notification.dispatch_unavailable", recoveryAttempt });
        const delay = RESULT_NOTIFICATION_RECOVERY_BACKOFF_MS[recoveryAttempt++];
        if (delay !== undefined) { schedule(delay); }
      }
    })().finally(() => {
      pumping = undefined;
      if (queued && !stopped) { schedule(SCHEDULER_WAKE_DEBOUNCE_MS); }
    });
    return pumping;
  };
  const dispatcher: ResultNotificationDispatcher = {
    wake: reason => {
      if (stopped) { return; }
      queued = true;
      logger.info({ event: "result_notification.wake", reason });
      if (!pumping) { schedule(SCHEDULER_WAKE_DEBOUNCE_MS); }
    },
    stop: () => { stopped = true; clearTimeout(timer); },
    drain: async () => { await pumping; await Promise.all(active.values()); }
  };
  return dispatcher;
};
