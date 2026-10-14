import type { Client } from "discord.js";
import type { Logger } from "pino";
import * as Effect from "effect/Effect";

import type { AppContext } from "../../appContext.ts";
import {
  OUTBOX_WORKER_ACTIVE_INTERVAL_MS,
  SCHEDULER_MIN_TIMER_DELAY_MS,
  SCHEDULER_RECOVERY_BACKOFF_MS
} from "../../config.ts";
import { runOutboxWorkerTick } from "./attendanceBatch.ts";
import { runEffectTickSafely } from "../../scheduler/tickRunner.ts";
import type { DeliveryRuntime } from "./runtime.ts";
import { readAttendanceDispatchAt } from "./sources/attendance.ts";

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const isDue = (at: Date | null, now: Date): boolean => at !== null && at.getTime() <= now.getTime();
const delayUntil = (now: Date, at: Date): number =>
  Math.max(SCHEDULER_MIN_TIMER_DELAY_MS, Math.min(MAX_TIMER_DELAY_MS, at.getTime() - now.getTime()));

export interface AttendanceDeliveryRuntime extends DeliveryRuntime {
  /** Accept a query already shared with scheduler hint reads; retain wakes across a running batch. */
  schedule(nextDispatchAt: Date | null, now: Date): void;
}

export const createAttendanceDeliveryRuntime = (deps: {
  readonly client: Client;
  readonly context: AppContext;
  readonly logger: Pick<Logger, "debug" | "error" | "info" | "warn">;
  readonly onWake: (reason: string) => void;
}): AttendanceDeliveryRuntime => {
  const { client, context, logger } = deps;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = false;
  let stopped = false;
  let pending: Promise<void> | undefined;
  let wakeQueued = false;
  let recoveryAttempt = 0;
  let recoveryNotBefore: number | undefined;

  const clearTimer = (): void => {
    clearTimeout(timer);
    timer = undefined;
  };

  const stopWorker = (reason: string): void => {
    clearTimer();
    if (!active) { return; }
    active = false;
    logger.info({ event: "scheduler.worker_stopped", worker: "outbox_worker", reason });
  };

  const scheduleLoop = (delayMs: number): void => {
    if (timer !== undefined && recoveryNotBefore !== undefined && context.clock.now().getTime() < recoveryNotBefore) {
      return;
    }
    clearTimer();
    if (stopped) { return; }
    // Explicit wakes may discover new rows, but must not shorten a failed tick's backoff.
    const remainingBackoff = Math.max(0, (recoveryNotBefore ?? 0) - context.clock.now().getTime());
    timer = setTimeout(() => {
      timer = undefined;
      run();
    }, Math.max(delayMs, remainingBackoff));
  };

  const schedule = (nextDispatchAt: Date | null, now: Date): void => {
    if (stopped) { return; }
    if (nextDispatchAt === null) {
      stopWorker("no_work");
      return;
    }
    if (isDue(nextDispatchAt, now)) {
      if (!active) {
        active = true;
        logger.info({ event: "scheduler.worker_started", worker: "outbox_worker", reason: "work_available" });
      }
      scheduleLoop(SCHEDULER_MIN_TIMER_DELAY_MS);
      return;
    }
    stopWorker("waiting_for_next_attempt");
    const delayMs = delayUntil(now, nextDispatchAt);
    timer = setTimeout(() => {
      timer = undefined;
      runtime.wake("outbox_timer_fired");
    }, delayMs);
    logger.info({ event: "scheduler.timer_scheduled", timer: "outbox_worker", targetAt: nextDispatchAt.toISOString(), delayMs });
  };

  const continueLoop = Effect.fnUntraced(function* () {
    if (stopped) { return; }
    const now = context.clock.now();
    const nextDispatchAt = yield* readAttendanceDispatchAt(context, now);
    if (stopped) { return; }
    if (isDue(nextDispatchAt, now)) {
      scheduleLoop(OUTBOX_WORKER_ACTIVE_INTERVAL_MS);
      return;
    }
    stopWorker("idle");
    schedule(nextDispatchAt, now);
  });

  const run = (): void => {
    if (stopped || pending) { return; }
    let succeeded = false;
    pending = runEffectTickSafely({ name: "outbox_worker", logger }, () => Effect.scoped(Effect.gen(function* () {
      yield* runOutboxWorkerTick(client, context, () => stopped);
      yield* continueLoop();
    })), () => { succeeded = true; }).finally(() => {
      pending = undefined;
      if (succeeded) {
        recoveryAttempt = 0;
        recoveryNotBefore = undefined;
      } else {
        const delay = SCHEDULER_RECOVERY_BACKOFF_MS[recoveryAttempt];
        recoveryAttempt = Math.min(recoveryAttempt + 1, SCHEDULER_RECOVERY_BACKOFF_MS.length);
        if (delay !== undefined) {
          recoveryNotBefore = context.clock.now().getTime() + delay;
          scheduleLoop(delay);
        }
      }
      if (wakeQueued && !stopped) {
        wakeQueued = false;
        deps.onWake("outbox_work_queued");
      }
    });
  };

  const runtime: AttendanceDeliveryRuntime = {
    wake: reason => {
      if (stopped) { return; }
      if (pending) { wakeQueued = true; }
      else { deps.onWake(reason); }
    },
    schedule: (nextDispatchAt, now) => {
      if (stopped) { return; }
      // A query taken during an active batch may predate its last commit. Read again after settlement.
      if (pending) { wakeQueued = true; }
      else { schedule(nextDispatchAt, now); }
    },
    stop: () => { stopped = true; stopWorker("shutdown"); },
    drain: async () => { await pending; }
  };
  return runtime;
};
