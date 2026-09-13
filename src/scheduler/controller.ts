import type { Client } from "discord.js";
import type { Logger } from "pino";
import * as Effect from "effect/Effect";

import type { AppContext } from "../appContext.ts";
import {
  OUTBOX_WORKER_ACTIVE_INTERVAL_MS,
  SCHEDULER_MIN_TIMER_DELAY_MS,
  SCHEDULER_WAKE_DEBOUNCE_MS
} from "../config.ts";
import { AppError, InvariantViolationError } from "../errors/index.ts";
import { fromAppCall, fromDatabaseCall } from "../errors/effect.ts";
import { logger as defaultLogger } from "../logger.ts";
import { runPromiseBoundary } from "../runtime/effect.ts";
import { reconcileOutboxClaims } from "./reconciler.outboxClaims.ts";
import { runOutboxWorkerTick } from "./outboxWorker.ts";
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

export interface SchedulerControllerDeps {
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

const readDatabase = <T>(call: () => Promise<T>, message: string): Promise<T> =>
  runPromiseBoundary(fromDatabaseCall(call, message));

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
  const running = new Map<TimerKind | "outbox_worker", Promise<void>>();
  let outboxWakeQueued = false;

  const runOwnedTick = (
    kind: TimerKind | "outbox_worker",
    run: () => SchedulerEffect<unknown>,
    onSuccess?: () => Promise<void>
  ): Promise<void> => {
    if (stopped) { return Promise.resolve(); }
    const current = running.get(kind);
    if (current) { return current; }
    const pending = runEffectTickSafely({ name: kind, logger }, run, onSuccess).finally(() => {
      running.delete(kind);
      if (kind === "outbox_worker" && outboxWakeQueued && !stopped) {
        outboxWakeQueued = false;
        controller.wake("outbox_work_queued");
      }
    });
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

  const scheduleOutboxLoop = (delayMs: number): void => {
    clearOutboxTimer();
    if (stopped) {return;}
    outboxTimer = setTimeout(() => {
      outboxTimer = undefined;
      void runOwnedTick(
        "outbox_worker",
        () => runOutboxWorkerTick(client, context, () => stopped),
        continueOutboxLoop
      );
    }, delayMs);
  };

  const continueOutboxLoop = async (): Promise<void> => {
    if (stopped) { return; }
    const now = context.clock.now();
    const nextDispatchAt = await readDatabase(
      () => context.ports.outbox.getNextDispatchAt(now),
      "Failed to read next outbox dispatch time."
    );
    if (stopped) { return; }
    if (isDue(nextDispatchAt, now)) {
      scheduleOutboxLoop(OUTBOX_WORKER_ACTIVE_INTERVAL_MS);
      return;
    }
    stopOutboxWorker("idle");
    scheduleOutbox(nextDispatchAt, now);
  };

  const scheduleOutbox = (nextDispatchAt: Date | null, now: Date): void => {
    if (stopped) { return; }
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

  const runDueSessionWork = async (): Promise<boolean> => {
    // A due reminder remains due until the outbox worker successfully delivers it and
    // completes the Session. Do not wake the controller after every attempted tick, or
    // the same due row can cause an unbounded recompute loop. A different due kind created
    // by a transition is still drained in this recompute, but each kind is attempted once.
    const attemptedDueKinds = new Set<TimerKind>();
    let didRun = false;

    while (true) {
      if (stopped) { return didRun; }
      const now = context.clock.now();
      const [sessionHints, nextOutboxDispatchAt] = await runPromiseBoundary(Effect.all([
        fromDatabaseCall(
          () => context.ports.sessions.getSchedulerSessionHints(now),
          "Failed to read scheduler session hints."
        ),
        fromDatabaseCall(
          () => context.ports.outbox.getNextDispatchAt(now),
          "Failed to read next outbox dispatch time."
        )
      ], { concurrency: 2 }));
      if (stopped) { return didRun; }
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
        await runOwnedTick(kind, run);
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
        if (running.has("outbox_worker")) {
          // race: 配送後のidle queryと交差したwakeを、batch完了後に再読込する。
          outboxWakeQueued = true;
        } else {
          scheduleOutbox(nextOutboxDispatchAt, now);
        }
        return didRun;
      }
      didRun = true;
    }
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
        const didRun = await runDueSessionWork();
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
    drain: async () => { await Promise.allSettled([recomputeInFlight, ...running.values()]); },
    recompute
  };

  return controller;
};

export const runSchedulerSupervisorTick = (
  ctx: AppContext,
  controller: SchedulerController
): SchedulerEffect<{ readonly outboxClaimReleased: number }> =>
  Effect.flatMap(reconcileOutboxClaims(ctx), (outboxClaimReleased) =>
    Effect.map(fromAppCall(
      () => controller.recompute("supervisor"),
      (cause) => cause instanceof AppError
        ? cause
        : new InvariantViolationError("Failed to recompute scheduler state.", { cause })
    ), () => ({ outboxClaimReleased })));
