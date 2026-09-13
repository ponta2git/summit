// Scheduler entry: register all cron tasks once per process (Fly single-instance).
// Each tick is wrapped by `runTickSafely` for failure isolation; literal schedules
// live in src/config.ts (CRON_*). @see docs/architecture.md

import * as Effect from "effect/Effect";
import cron, { type ScheduledTask } from "node-cron";
import type { Client } from "discord.js";

import type { AppContext } from "../appContext.ts";
import {
  CRON_ASK_SCHEDULE,
  CRON_OUTBOX_RETENTION_SCHEDULE,
  CRON_SCHEDULER_SUPERVISOR_SCHEDULE,
  MEMBER_COUNT_EXPECTED
} from "../config.ts";
import type { SessionRow } from "../db/rows.ts";
import { fromAppCall, fromDatabaseCall, mapDatabaseError } from "../errors/effect.ts";
import {
  sendAskMessage,
  type SendAskMessageContext,
  type SendAskMessageResult
} from "../features/ask-session/send.ts";
import { evaluateAndApplyDeadlineDecision, settlePostponeVotingSession } from "../orchestration/index.ts";
import { sendReminderForSession } from "../features/reminder/send.ts";
import { logger } from "../logger.ts";
import { runOutboxMetricsTick } from "./outboxMetrics.ts";
import { runOutboxRetentionTick } from "./outboxRetention.ts";
import {
  createSchedulerController,
  runSchedulerSupervisorTick,
  type SchedulerController
} from "./controller.ts";
import {
  runEffectTickSafely
} from "./tickRunner.ts";
import {
  type SchedulerFailure,
  type SchedulerEffect,
  type SchedulerBatchReport,
  runSchedulerBatchEffect
} from "./scheduler.types.ts";

export { runStartupRecovery } from "./startupRecovery.ts";

type SendAsk = (context: SendAskMessageContext) => Promise<SendAskMessageResult>;

const logSchedulerFailure = (failure: SchedulerFailure): void => {
  logger.error(
    {
      error: failure.error,
      errorCode: failure.error.code,
      phase: failure.phase,
      ...(failure.sessionId === undefined ? {} : { sessionId: failure.sessionId }),
      ...(failure.weekKey === undefined ? {} : { weekKey: failure.weekKey }),
      ...(failure.outboxId === undefined ? {} : { outboxId: failure.outboxId })
    },
    "Scheduler operation failed for an item."
  );
};

interface CronAdapter {
  schedule(
    expression: string,
    handler: () => void | Promise<void>,
    options: { timezone: string; noOverlap: boolean }
  ): Pick<ScheduledTask, "stop">;
}

export interface AskSchedulerDeps {
  readonly client: Client;
  readonly context: AppContext;
  readonly sendAsk?: SendAsk;
  readonly cronAdapter?: CronAdapter;
  readonly wakeResultNotifications?: (reason: string) => void;
}

export interface AppScheduler {
  readonly controller: SchedulerController;
  stop(): void;
  drain(): Promise<void>;
  wake(reason: string): void;
}

export const runScheduledAskTick = (
  sendAsk: SendAsk,
  context: AppContext
): SchedulerEffect<SendAskMessageResult> =>
  fromAppCall(
    () => sendAsk({ trigger: "cron", context }),
    mapDatabaseError("Failed to queue ASK message.")
  );

const settleDueAskingSession = (
  client: Client,
  ctx: AppContext,
  session: SessionRow,
  now: Date
): SchedulerEffect<void> =>
  evaluateAndApplyDeadlineDecision(client, ctx, session, {
    memberCountExpected: MEMBER_COUNT_EXPECTED,
    now
  });

/**
 * Settle every ASKING session whose deadline has passed.
 *
 * @remarks
 * idempotent: settle は CAS 済みのためセッション単位の重複呼び出しに安全。
 * 例外はセッション単位で log に集約し、外側 `runTickSafely` に委譲する。
 */
export const runDeadlineTick = (
  client: Client,
  ctx: AppContext
): SchedulerEffect<SchedulerBatchReport> => Effect.suspend(() => {
  const now = ctx.clock.now();
  return Effect.flatMap(fromDatabaseCall(
    () => ctx.ports.sessions.findDueAskingSessions(now),
    "Failed to find due ASKING sessions."
  ), (due) =>
    runSchedulerBatchEffect(
      "deadline",
      due,
      (session) => settleDueAskingSession(client, ctx, session, now),
      (session) => ({ sessionId: session.id, weekKey: session.weekKey }),
      logSchedulerFailure
    ));
});

/**
 * Settle every POSTPONE_VOTING session whose deadline has passed.
 *
 * @remarks
 * source-of-truth: DB から期限切れセッションを再計算して処理する。
 * idempotent: settlePostponeVotingSession は内部 CAS で重複呼び出し安全。
 */
export const runPostponeDeadlineTick = (
  client: Client,
  ctx: AppContext
): SchedulerEffect<SchedulerBatchReport> => Effect.suspend(() => {
  const now = ctx.clock.now();
  return Effect.flatMap(fromDatabaseCall(
    () => ctx.ports.sessions.findDuePostponeVotingSessions(now),
    "Failed to find due POSTPONE_VOTING sessions."
  ), (due) =>
    runSchedulerBatchEffect(
      "postpone_deadline",
      due,
      (session) => settlePostponeVotingSession(client, ctx, session, now),
      (session) => ({ sessionId: session.id, weekKey: session.weekKey }),
      logSchedulerFailure
    ));
});

/**
 * Dispatch the pre-start reminder for DECIDED sessions whose `reminderAt` has passed.
 *
 * @remarks
 * source-of-truth: reminder intent を outbox に積み、配送成功後に DECIDED→COMPLETED へ遷移する。
 * 送信失敗時は outbox backoff で再試行する。
 */
export const runReminderTick = (
  client: Client,
  ctx: AppContext
): SchedulerEffect<SchedulerBatchReport> => Effect.suspend(() => {
  const now = ctx.clock.now();
  return Effect.flatMap(fromDatabaseCall(
    () => ctx.ports.sessions.findDueReminderSessions(now),
    "Failed to find due reminder sessions."
  ), (due) =>
    runSchedulerBatchEffect(
      "reminder",
      due,
      (session) =>
        fromAppCall(
          () => sendReminderForSession(client, ctx, session.id, now),
          mapDatabaseError("Failed to enqueue reminder.")
        ),
      (session) => ({ sessionId: session.id, weekKey: session.weekKey }),
      logSchedulerFailure
    ));
});

/**
 * Register all scheduled cron tasks. Call once per process.
 *
 * @remarks
 * single-instance: node-cron はプロセスあたり 1 回のみ登録。Fly app を scale すると
 *   二重駆動する (Discord 二重送信 / race)。
 * source-of-truth: 各 tick は DB から再計算する。in-memory 状態に依存しない。
 * idempotent: `noOverlap: true` で次 tick が現 tick と重なった場合は後続をスキップする。
 * 戻り値は shutdown 時に `stop()` で cron と in-memory timer をまとめて停止する。
 */
export const createAskScheduler = (deps: AskSchedulerDeps): AppScheduler => {
  const { context, client } = deps;
  const sendAsk =
    deps.sendAsk ?? ((sendContext: SendAskMessageContext) => sendAskMessage(sendContext));
  const cronModule = deps.cronAdapter ?? cron;
  const controller = createSchedulerController({
    client,
    context,
    runDeadlineTick: () => runDeadlineTick(client, context),
    runPostponeDeadlineTick: () => runPostponeDeadlineTick(client, context),
    runReminderTick: () => runReminderTick(client, context)
  });

  // why: 新 feature の tick 追加箇所を registry に集約する。cron 式と JST 前提は src/config.ts の CRON_* に集約。
  const taskDefs: ReadonlyArray<{ readonly schedule: string; readonly tick: () => Promise<void> }> = [
    {
      schedule: CRON_ASK_SCHEDULE,
      tick: () =>
        runEffectTickSafely(
          { name: "ask_dispatch", logger },
          () => runScheduledAskTick(sendAsk, context),
          () => controller.wake("ask_dispatch")
        )
    },
    {
      schedule: CRON_OUTBOX_RETENTION_SCHEDULE,
      tick: async () => {
        await Promise.allSettled([runEffectTickSafely(
          { name: "outbox_retention", logger },
          () => runOutboxRetentionTick(context)
        ), runEffectTickSafely(
          { name: "result_notification_retention", logger },
          () => fromDatabaseCall(() => context.ports.resultNotifications.prune(context.clock.now()), "Failed to prune result notifications.")
        )]);
      }
    },
    {
      schedule: CRON_SCHEDULER_SUPERVISOR_SCHEDULE,
      tick: () => {
        deps.wakeResultNotifications?.("supervisor");
        return runEffectTickSafely(
          { name: "scheduler_supervisor", logger },
          () =>
            Effect.flatMap(runOutboxMetricsTick(context), () =>
              runSchedulerSupervisorTick(context, controller))
        );
      }
    }
  ];

  let stopped = false;
  const running = new Set<Promise<void>>();
  const track = (operation: () => void | Promise<void>): Promise<void> => {
    const pending = (async () => { await operation(); })().finally(() => { running.delete(pending); });
    running.add(pending);
    return pending;
  };
  const tasks = taskDefs.map((def) => cronModule.schedule(def.schedule,
    () => stopped ? Promise.resolve() : track(def.tick), { timezone: "Asia/Tokyo", noOverlap: true }));

  controller.wake("scheduler_created");

  return {
    controller,
    stop: () => {
      stopped = true;
      controller.stop();
      for (const task of tasks) {
        void track(async () => {
          try { await task.stop(); }
          catch (error: unknown) { logger.error({ error }, "Failed to stop cron task."); }
        });
      }
    },
    drain: async () => { await Promise.allSettled([controller.drain(), ...running]); },
    wake: (reason) => controller.wake(reason)
  };
};
