import type { Client } from "discord.js";
import type { Logger } from "pino";

import type { AppContext } from "../appContext.js";
import {
  OUTBOX_WORKER_ACTIVE_INTERVAL_MS,
  SCHEDULER_MIN_TIMER_DELAY_MS,
  SCHEDULER_WAKE_DEBOUNCE_MS
} from "../config.js";
import { logger as defaultLogger } from "../logger.js";
import { runReconciler } from "./reconciler.js";
import { reconcileOutboxClaims } from "./reconciler.outboxClaims.js";
import { runOutboxWorkerTick } from "./outboxWorker.js";
import { runTickSafely } from "./tickRunner.js";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

type TimeoutHandle = ReturnType<typeof setTimeout>;

type TimerKind = "deadline" | "postpone_deadline" | "reminder";
type SchedulerLogger = Pick<Logger, "debug" | "error" | "info" | "warn">;

export interface SchedulerController {
  wake(reason: string): void;
  stop(): void;
  recompute(reason: string): Promise<void>;
}

export interface SchedulerControllerDeps {
  readonly client: Client;
  readonly context: AppContext;
  readonly runDeadlineTick: () => Promise<void>;
  readonly runPostponeDeadlineTick: () => Promise<void>;
  readonly runReminderTick: () => Promise<void>;
  readonly logger?: SchedulerLogger;
}

const isDue = (at: Date | null, now: Date): boolean =>
  at !== null && at.getTime() <= now.getTime();

const delayUntil = (now: Date, at: Date): number =>
  Math.max(
    SCHEDULER_MIN_TIMER_DELAY_MS,
    Math.min(MAX_TIMER_DELAY_MS, at.getTime() - now.getTime())
  );

export const createSchedulerController = (
  deps: SchedulerControllerDeps
): SchedulerController => {
  const { client, context, logger = defaultLogger } = deps;
  const timers = new Map<TimerKind, TimeoutHandle>();
  let wakeTimer: TimeoutHandle | undefined;
  let recomputeInFlight: Promise<void> | undefined;
  let recomputeQueued = false;
  let stopped = false;
  let outboxTimer: TimeoutHandle | undefined;
  let outboxActive = false;

  const clearTimer = (kind: TimerKind): void => {
    const handle = timers.get(kind);
    if (!handle) {return;}
    clearTimeout(handle);
    timers.delete(kind);
    logger.debug({ event: "scheduler.timer_cancelled", timer: kind });
  };

  const clearAllTimers = (): void => {
    for (const kind of [...timers.keys()]) {
      clearTimer(kind);
    }
  };

  const clearOutboxTimer = (): void => {
    if (!outboxTimer) {return;}
    clearTimeout(outboxTimer);
    outboxTimer = undefined;
  };

  const stopOutboxWorker = (reason: string): void => {
    clearOutboxTimer();
    if (!outboxActive) {return;}
    outboxActive = false;
    logger.info({ event: "scheduler.worker_stopped", worker: "outbox_worker", reason });
  };

  const scheduleTimer = (kind: TimerKind, at: Date | null, run: () => Promise<void>): void => {
    clearTimer(kind);
    if (at === null || stopped) {return;}

    const now = context.clock.now();
    const delayMs = delayUntil(now, at);
    const handle = setTimeout(() => {
      timers.delete(kind);
      void runTickSafely({ name: kind, logger }, run)
        .finally(() => controller.wake(`${kind}_timer_fired`));
    }, delayMs);
    timers.set(kind, handle);
    logger.info({
      event: "scheduler.timer_scheduled",
      timer: kind,
      targetAt: at.toISOString(),
      delayMs
    });
  };

  const scheduleOutboxLoop = (delayMs: number): void => {
    clearOutboxTimer();
    if (stopped) {return;}
    outboxTimer = setTimeout(() => {
      outboxTimer = undefined;
      void runTickSafely({ name: "outbox_worker", logger }, async () => {
        await runOutboxWorkerTick(client, context);
        const now = context.clock.now();
        const nextDispatchAt = await context.ports.outbox.getNextDispatchAt(now);
        if (isDue(nextDispatchAt, now)) {
          scheduleOutboxLoop(OUTBOX_WORKER_ACTIVE_INTERVAL_MS);
          return;
        }
        stopOutboxWorker("idle");
        scheduleOutbox(nextDispatchAt, now);
      });
    }, delayMs);
  };

  const scheduleOutbox = (nextDispatchAt: Date | null, now: Date): void => {
    if (nextDispatchAt === null) {
      stopOutboxWorker("no_work");
      return;
    }

    if (isDue(nextDispatchAt, now)) {
      if (!outboxActive) {
        outboxActive = true;
        logger.info({
          event: "scheduler.worker_started",
          worker: "outbox_worker",
          reason: "work_available"
        });
      }
      scheduleOutboxLoop(SCHEDULER_MIN_TIMER_DELAY_MS);
      return;
    }

    stopOutboxWorker("waiting_for_next_attempt");
    clearOutboxTimer();
    const delayMs = delayUntil(now, nextDispatchAt);
    outboxTimer = setTimeout(() => {
      outboxTimer = undefined;
      controller.wake("outbox_timer_fired");
    }, delayMs);
    logger.info({
      event: "scheduler.timer_scheduled",
      timer: "outbox_worker",
      targetAt: nextDispatchAt.toISOString(),
      delayMs
    });
  };

  const runDueSessionWork = async (
    reason: string
  ): Promise<boolean> => {
    const now = context.clock.now();
    const [sessionHints, nextOutboxDispatchAt] = await Promise.all([
      context.ports.sessions.getSchedulerSessionHints(now),
      context.ports.outbox.getNextDispatchAt(now)
    ]);

    let didRun = false;
    if (isDue(sessionHints.nextAskingDeadlineAt, now)) {
      clearTimer("deadline");
      await runTickSafely({ name: "deadline", logger }, deps.runDeadlineTick);
      didRun = true;
    } else {
      scheduleTimer("deadline", sessionHints.nextAskingDeadlineAt, deps.runDeadlineTick);
    }

    if (isDue(sessionHints.nextPostponeDeadlineAt, now)) {
      clearTimer("postpone_deadline");
      await runTickSafely({ name: "postpone_deadline", logger }, deps.runPostponeDeadlineTick);
      didRun = true;
    } else {
      scheduleTimer(
        "postpone_deadline",
        sessionHints.nextPostponeDeadlineAt,
        deps.runPostponeDeadlineTick
      );
    }

    if (isDue(sessionHints.nextReminderAt, now)) {
      clearTimer("reminder");
      await runTickSafely({ name: "reminder", logger }, deps.runReminderTick);
      didRun = true;
    } else {
      scheduleTimer("reminder", sessionHints.nextReminderAt, deps.runReminderTick);
    }

    if (didRun) {
      controller.wake(`${reason}_due_work_finished`);
      return true;
    }

    scheduleOutbox(nextOutboxDispatchAt, now);
    return false;
  };

  const recompute = async (reason: string): Promise<void> => {
    if (stopped) {return;}
    if (recomputeInFlight) {
      recomputeQueued = true;
      return recomputeInFlight;
    }

    recomputeInFlight = (async () => {
      const startedAt = performance.now();
      logger.info({ event: "scheduler.recompute_started", reason });
      try {
        const didRun = await runDueSessionWork(reason);
        logger.info({
          event: "scheduler.recompute_finished",
          reason,
          elapsedMs: performance.now() - startedAt,
          didRun
        });
      } catch (error: unknown) {
        logger.error({
          event: "scheduler.recompute_failed",
          reason,
          elapsedMs: performance.now() - startedAt,
          error
        });
      }
    })()
      .finally(() => {
        recomputeInFlight = undefined;
        if (recomputeQueued && !stopped) {
          recomputeQueued = false;
          controller.wake("queued_recompute");
        }
      });

    return recomputeInFlight;
  };

  const controller: SchedulerController = {
    wake: (reason) => {
      if (stopped) {return;}
      logger.info({ event: "scheduler.wake_requested", reason });
      if (wakeTimer) {return;}
      wakeTimer = setTimeout(() => {
        wakeTimer = undefined;
        void recompute(reason);
      }, SCHEDULER_WAKE_DEBOUNCE_MS);
    },
    stop: () => {
      stopped = true;
      if (wakeTimer) {
        clearTimeout(wakeTimer);
        wakeTimer = undefined;
      }
      clearAllTimers();
      stopOutboxWorker("shutdown");
    },
    recompute
  };

  return controller;
};

export const runSchedulerSupervisorTick = async (
  client: Client,
  ctx: AppContext,
  controller: SchedulerController
): Promise<void> => {
  await runReconciler(client, ctx, { scope: "tick" });
  await reconcileOutboxClaims(ctx);
  await controller.recompute("supervisor");
};
