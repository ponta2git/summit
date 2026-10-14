import type { Client } from "discord.js";
import type { Logger } from "pino";
import * as Effect from "effect/Effect";

import type { AppContext } from "../appContext.ts";
import {
  SCHEDULER_MIN_TIMER_DELAY_MS,
  SCHEDULER_RECOVERY_BACKOFF_MS,
  SCHEDULER_WAKE_DEBOUNCE_MS
} from "../config.ts";
import { AppError, InvariantViolationError } from "../errors/index.ts";
import { fromAppCall, fromDatabaseCall } from "../errors/effect.ts";
import { logger as defaultLogger } from "../logger.ts";
import { runPromiseBoundary } from "../runtime/effect.ts";
import { reconcileOutboxClaims } from "./reconciler.outboxClaims.ts";
import { createAttendanceDeliveryRuntime } from "../notifications/delivery/composition.attendance.ts";
import { readAttendanceDispatchAt } from "../notifications/delivery/sources/attendance.ts";
import { runEffectTickSafely } from "./tickRunner.ts";
import type { SchedulerEffect } from "./scheduler.types.ts";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

type TimeoutHandle = ReturnType<typeof setTimeout>;

type TimerKind = "deadline" | "postpone_deadline" | "reminder";
type SchedulerLogger = Pick<Logger, "debug" | "error" | "info" | "warn">;

export interface SchedulerController {
  wake(reason: string): void;
  stop(): void;
  drain(): Promise<void>;
  recompute(reason: string): Promise<void>;
}

interface SchedulerControllerDeps {
  readonly client: Client;
  readonly context: AppContext;
  readonly runDeadlineTick: () => SchedulerEffect<unknown>;
  readonly runPostponeDeadlineTick: () => SchedulerEffect<unknown>;
  readonly runReminderTick: () => SchedulerEffect<unknown>;
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
  let recoveryTimer: TimeoutHandle | undefined;
  let recomputeRecoveryAttempt = 0;
  let stopped = false;
  const running = new Map<TimerKind, Promise<boolean>>();
  const attendance = createAttendanceDeliveryRuntime({ client, context, logger,
    onWake: reason => controller.wake(reason) });

  const runOwnedTick = (
    kind: TimerKind,
    run: () => SchedulerEffect<unknown>
  ): Promise<boolean> => {
    if (stopped) { return Promise.resolve(false); }
    const current = running.get(kind);
    if (current) { return current; }
    let succeeded = false;
    const pending = runEffectTickSafely({ name: kind, logger }, run, () => {
      succeeded = true;
    }).then(() => succeeded).finally(() => { running.delete(kind); });
    running.set(kind, pending);
    return pending;
  };

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

  const scheduleTimer = (
    kind: TimerKind,
    at: Date | null,
    run: () => SchedulerEffect<unknown>
  ): void => {
    clearTimer(kind);
    if (at === null || stopped) {return;}

    const now = context.clock.now();
    const delayMs = delayUntil(now, at);
    const handle = setTimeout(() => {
      timers.delete(kind);
      void runOwnedTick(kind, run)
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

  const runDueSessionWork = async (): Promise<{ readonly didRun: boolean; readonly failed: boolean }> => {
    // A due reminder remains due until the outbox worker successfully delivers it and
    // completes the Session. Do not wake the controller after every attempted tick, or
    // the same due row can cause an unbounded recompute loop. A different due kind created
    // by a transition is still drained in this recompute, but each kind is attempted once.
    const attemptedDueKinds = new Set<TimerKind>();
    let didRun = false;
    let failed = false;

    while (true) {
      if (stopped) { return { didRun, failed }; }
      const now = context.clock.now();
      const [sessionHints, nextOutboxDispatchAt] = await runPromiseBoundary(Effect.all([
        fromDatabaseCall(
          () => context.ports.sessions.getSchedulerSessionHints(now),
          "Failed to read scheduler session hints."
        ),
        readAttendanceDispatchAt(context)
      ], { concurrency: 2 }));
      if (stopped) { return { didRun, failed }; }
      let ranThisPass = false;

      const runIfDue = async (
        kind: TimerKind,
        at: Date | null,
        run: () => SchedulerEffect<unknown>
      ): Promise<void> => {
        if (stopped) { return; }
        if (!isDue(at, now)) {
          scheduleTimer(kind, at, run);
          return;
        }

        clearTimer(kind);
        if (attemptedDueKinds.has(kind)) {
          // The operation may intentionally leave the timestamp due while an async
          // outbox delivery is pending. The supervisor will retry if it remains due.
          return;
        }
        attemptedDueKinds.add(kind);
        if (!await runOwnedTick(kind, run)) { failed = true; }
        ranThisPass = true;
      };

      await runIfDue("deadline", sessionHints.nextAskingDeadlineAt, deps.runDeadlineTick);
      await runIfDue(
        "postpone_deadline",
        sessionHints.nextPostponeDeadlineAt,
        deps.runPostponeDeadlineTick
      );
      await runIfDue("reminder", sessionHints.nextReminderAt, deps.runReminderTick);

      if (!ranThisPass) {
        // Re-read after due work so an intent enqueued by the tick is visible to the
        // outbox scheduler in the same recompute.
        attendance.schedule(nextOutboxDispatchAt, now);
        return { didRun, failed };
      }
      didRun = true;
    }
  };

  const retryRecompute = (): void => {
    if (stopped || recoveryTimer !== undefined) { return; }
    const delay = SCHEDULER_RECOVERY_BACKOFF_MS[recomputeRecoveryAttempt];
    recomputeRecoveryAttempt = Math.min(recomputeRecoveryAttempt + 1, SCHEDULER_RECOVERY_BACKOFF_MS.length);
    if (delay === undefined) { return; }
    recoveryTimer = setTimeout(() => {
      recoveryTimer = undefined;
      void recompute("recovery_retry");
    }, delay);
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
        const { didRun, failed } = await runDueSessionWork();
        if (failed) { retryRecompute(); }
        else {
          recomputeRecoveryAttempt = 0;
          clearTimeout(recoveryTimer);
          recoveryTimer = undefined;
        }
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
        retryRecompute();
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
      clearTimeout(recoveryTimer);
      recoveryTimer = undefined;
      if (wakeTimer) {
        clearTimeout(wakeTimer);
        wakeTimer = undefined;
      }
      clearAllTimers();
      attendance.stop();
    },
    drain: async () => { await Promise.allSettled([recomputeInFlight, ...running.values(), attendance.drain()]); },
    recompute
  };

  return controller;
};

export const runSchedulerSupervisorTick = (
  ctx: AppContext,
  controller: SchedulerController
): SchedulerEffect<{ readonly outboxClaimReleased: number }> =>
  Effect.map(Effect.all([
    reconcileOutboxClaims(ctx),
    fromAppCall(
      () => controller.recompute("supervisor"),
      (cause) => cause instanceof AppError
        ? cause
        : new InvariantViolationError("Failed to recompute scheduler state.", { cause })
    )
  ], { concurrency: 2 }), ([outboxClaimReleased]) => ({ outboxClaimReleased }));
