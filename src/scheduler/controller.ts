import type { Client } from "discord.js";
import type { Logger } from "pino";

import type { AppContext } from "../appContext.ts";
import {
  OUTBOX_WORKER_ACTIVE_INTERVAL_MS,
  SCHEDULER_MIN_TIMER_DELAY_MS,
  SCHEDULER_WAKE_DEBOUNCE_MS
} from "../config.ts";
import { AppError, InvariantViolationError } from "../errors/index.ts";
import { fromAppCall, fromDatabaseCall, unwrapResultAsync } from "../errors/result.ts";
import { logger as defaultLogger } from "../logger.ts";
import { reconcileOutboxClaims } from "./reconciler.outboxClaims.ts";
import { runOutboxWorkerTick } from "./outboxWorker.ts";
import { runResultTickSafely } from "./tickRunner.ts";
import type { SchedulerResult } from "./scheduler.types.ts";

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
  readonly runDeadlineTick: () => SchedulerResult<unknown>;
  readonly runPostponeDeadlineTick: () => SchedulerResult<unknown>;
  readonly runReminderTick: () => SchedulerResult<unknown>;
  readonly logger?: SchedulerLogger;
}

const isDue = (at: Date | null, now: Date): boolean =>
  at !== null && at.getTime() <= now.getTime();

const delayUntil = (now: Date, at: Date): number =>
  Math.max(
    SCHEDULER_MIN_TIMER_DELAY_MS,
    Math.min(MAX_TIMER_DELAY_MS, at.getTime() - now.getTime())
  );

const readDatabase = <T>(call: () => Promise<T>, message: string): Promise<T> =>
  unwrapResultAsync(fromDatabaseCall(call, message));

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

  const scheduleTimer = (
    kind: TimerKind,
    at: Date | null,
    run: () => SchedulerResult<unknown>
  ): void => {
    clearTimer(kind);
    if (at === null || stopped) {return;}

    const now = context.clock.now();
    const delayMs = delayUntil(now, at);
    const handle = setTimeout(() => {
      timers.delete(kind);
      void runResultTickSafely({ name: kind, logger }, run)
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
      void runResultTickSafely(
        { name: "outbox_worker", logger },
        () => runOutboxWorkerTick(client, context),
        continueOutboxLoop
      );
    }, delayMs);
  };

  const continueOutboxLoop = async (): Promise<void> => {
    const now = context.clock.now();
    const nextDispatchAt = await readDatabase(
      () => context.ports.outbox.getNextDispatchAt(now),
      "Failed to read next outbox dispatch time."
    );
    if (isDue(nextDispatchAt, now)) {
      scheduleOutboxLoop(OUTBOX_WORKER_ACTIVE_INTERVAL_MS);
      return;
    }
    stopOutboxWorker("idle");
    scheduleOutbox(nextDispatchAt, now);
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
      readDatabase(
        () => context.ports.sessions.getSchedulerSessionHints(now),
        "Failed to read scheduler session hints."
      ),
      readDatabase(
        () => context.ports.outbox.getNextDispatchAt(now),
        "Failed to read next outbox dispatch time."
      )
    ]);

    let didRun = false;
    if (isDue(sessionHints.nextAskingDeadlineAt, now)) {
      clearTimer("deadline");
      await runResultTickSafely({ name: "deadline", logger }, deps.runDeadlineTick);
      didRun = true;
    } else {
      scheduleTimer("deadline", sessionHints.nextAskingDeadlineAt, deps.runDeadlineTick);
    }

    if (isDue(sessionHints.nextPostponeDeadlineAt, now)) {
      clearTimer("postpone_deadline");
      await runResultTickSafely(
        { name: "postpone_deadline", logger },
        deps.runPostponeDeadlineTick
      );
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
      await runResultTickSafely({ name: "reminder", logger }, deps.runReminderTick);
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
          error,
          ...(error instanceof AppError ? { errorCode: error.code } : {})
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

export const runSchedulerSupervisorTick = (
  ctx: AppContext,
  controller: SchedulerController
): SchedulerResult<{ readonly outboxClaimReleased: number }> =>
  reconcileOutboxClaims(ctx).andThen((outboxClaimReleased) =>
    fromAppCall(
      () => controller.recompute("supervisor"),
      (cause) => cause instanceof AppError
        ? cause
        : new InvariantViolationError("Failed to recompute scheduler state.", { cause })
    ).map(() => ({ outboxClaimReleased }))
  );
