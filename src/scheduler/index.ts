// Scheduler entry: register all cron tasks once per process (Fly single-instance).
// Each tick is wrapped by `runTickSafely` for failure isolation; literal schedules
// live in src/config.ts (CRON_*). @see ADR-0001, ADR-0007, ADR-0033.

import cron, { type ScheduledTask } from "node-cron";
import type { Client } from "discord.js";

import type { AppContext } from "../appContext.js";
import {
  CRON_ASK_SCHEDULE,
  CRON_DEADLINE_SCHEDULE,
  CRON_OUTBOX_METRICS_SCHEDULE,
  CRON_OUTBOX_RETENTION_SCHEDULE,
  CRON_OUTBOX_WORKER_SCHEDULE,
  CRON_POSTPONE_DEADLINE_SCHEDULE,
  CRON_REMINDER_SCHEDULE,
  HEALTHCHECK_PING_INTERVAL_CRON,
  MEMBER_COUNT_EXPECTED
} from "../config.js";
import type { SessionRow } from "../db/rows.js";
import type { AppError } from "../errors/index.js";
import type { FetchFn } from "../healthcheck/ping.js";
import {
  sendAskMessage,
  type SendAskMessageContext,
  type SendAskMessageResult
} from "../features/ask-session/send.js";
import { evaluateAndApplyDeadlineDecision, settlePostponeVotingSession } from "../orchestration/index.js";
import { sendReminderForSession } from "../features/reminder/send.js"
import { logger } from "../logger.js";
import { runReconciler } from "./reconciler.js";
import { runOutboxMetricsTick } from "./outboxMetrics.js";
import { runOutboxRetentionTick } from "./outboxRetention.js";
import { runOutboxWorkerTick } from "./outboxWorker.js";
import { runHealthcheckTickPing } from "./healthcheckTick.js";
import { runTickSafely } from "./tickRunner.js";

export { runHealthcheckTickPing } from "./healthcheckTick.js";
export { runStartupRecovery } from "./startupRecovery.js";

type SendAsk = (context: SendAskMessageContext) => Promise<SendAskMessageResult>;

const logSessionResultError = (
  error: AppError,
  session: SessionRow,
  message: string
): void => {
  logger.error(
    {
      error,
      errorCode: error.code,
      sessionId: session.id,
      weekKey: session.weekKey
    },
    message
  );
};

interface CronAdapter {
  schedule(
    expression: string,
    handler: () => void | Promise<void>,
    options: { timezone: string; noOverlap: boolean }
  ): ScheduledTask;
}

export interface AskSchedulerDeps {
  readonly client: Client;
  readonly context: AppContext;
  readonly sendAsk?: SendAsk;
  readonly cronAdapter?: CronAdapter;
  readonly healthcheckUrl?: string;
  readonly fetchFn?: FetchFn;
}

export const runScheduledAskTick = async (
  sendAsk: SendAsk,
  context: AppContext
): Promise<void> => {
  await sendAsk({ trigger: "cron", context });
};

const settleDueAskingSession = async (
  client: Client,
  ctx: AppContext,
  session: SessionRow,
  now: Date
): Promise<void> => {
  const responses = await ctx.ports.responses.listResponses(session.id);
  await evaluateAndApplyDeadlineDecision(client, ctx, session, responses, {
    memberCountExpected: MEMBER_COUNT_EXPECTED,
    now
  }).match(
    () => {},
    (error) => logSessionResultError(error, session, "Failed to apply ask deadline decision.")
  );
};

/**
 * Settle every ASKING session whose deadline has passed.
 *
 * @remarks
 * idempotent: settle は CAS 済みのためセッション単位の重複呼び出しに安全。
 * 例外はセッション単位で log に集約し、外側 `runTickSafely` に委譲する。
 */
export const runDeadlineTick = async (
  client: Client,
  ctx: AppContext
): Promise<void> => {
  const now = ctx.clock.now();
  const due = await ctx.ports.sessions.findDueAskingSessions(now);
  for (const session of due) {
    try {
      await settleDueAskingSession(client, ctx, session, now);
    } catch (error: unknown) {
      logger.error(
        { error, sessionId: session.id, weekKey: session.weekKey },
        "Failed to settle ASKING session in deadline tick."
      );
    }
  }
};

/**
 * Settle every POSTPONE_VOTING session whose deadline has passed.
 *
 * @remarks
 * source-of-truth: DB から期限切れセッションを再計算して処理する。
 * idempotent: settlePostponeVotingSession は内部 CAS で重複呼び出し安全。
 * @see ADR-0001
 */
export const runPostponeDeadlineTick = async (
  client: Client,
  ctx: AppContext
): Promise<void> => {
  const now = ctx.clock.now();
  const due = await ctx.ports.sessions.findDuePostponeVotingSessions(now);
  for (const session of due) {
    await settlePostponeVotingSession(client, ctx, session, now).match(
      () => {},
      (error) =>
        logSessionResultError(
          error,
          session,
          "Failed to settle POSTPONE_VOTING session in postpone deadline tick."
        )
    );
  }
};

/**
 * Dispatch the pre-start reminder for DECIDED sessions whose `reminderAt` has passed.
 *
 * @remarks
 * source-of-truth: 送信後 DECIDED→COMPLETED へ遷移。送信失敗時は DECIDED 据え置きで次 tick で再試行。
 * invariant: 毎 tick 境界で stale reminder claim を回収する (H1 only; 他 invariant は起動時のみ)。
 * @see ADR-0024
 * @see ADR-0033
 */
export const runReminderTick = async (
  client: Client,
  ctx: AppContext
): Promise<void> => {
  await runReconciler(client, ctx, { scope: "tick" });
  const now = ctx.clock.now();
  const due = await ctx.ports.sessions.findDueReminderSessions(now);
  for (const session of due) {
    try {
      await sendReminderForSession(client, ctx, session.id, now);
    } catch (error: unknown) {
      logger.error(
        { error, sessionId: session.id, weekKey: session.weekKey },
        "Failed to dispatch reminder in reminder tick."
      );
    }
  }
};

/**
 * Register all scheduled cron tasks. Call once per process.
 *
 * @remarks
 * single-instance: node-cron はプロセスあたり 1 回のみ登録。Fly app を scale すると
 *   二重駆動する (Discord 二重送信 / race)。
 * source-of-truth: 各 tick は DB から再計算する。in-memory 状態に依存しない。
 * idempotent: `noOverlap: true` で次 tick が現 tick と重なった場合は後続をスキップする。
 * 戻り値は shutdown 時に `for (const t of tasks) t.stop()` で停止する。
 * @see ADR-0001
 */
export const createAskScheduler = (deps: AskSchedulerDeps): readonly ScheduledTask[] => {
  const { context, client } = deps;
  const sendAsk =
    deps.sendAsk ?? ((sendContext: SendAskMessageContext) => sendAskMessage(client, sendContext));
  const cronModule = deps.cronAdapter ?? cron;

  // why: 新 feature の tick 追加箇所を registry に集約する。cron 式と JST 前提は src/config.ts の CRON_* に集約。
  const taskDefs: ReadonlyArray<{ readonly schedule: string; readonly tick: () => void }> = [
    // @see ADR-0007
    {
      schedule: CRON_ASK_SCHEDULE,
      tick: () =>
        void runTickSafely({ name: "ask_dispatch", logger }, () =>
          runScheduledAskTick(sendAsk, context)
        )
    },
    {
      schedule: CRON_DEADLINE_SCHEDULE,
      tick: () =>
        void runTickSafely({ name: "deadline", logger }, () => runDeadlineTick(client, context))
    },
    {
      schedule: CRON_POSTPONE_DEADLINE_SCHEDULE,
      tick: () =>
        void runTickSafely({ name: "postpone_deadline", logger }, () =>
          runPostponeDeadlineTick(client, context)
        )
    },
    {
      schedule: CRON_REMINDER_SCHEDULE,
      tick: () =>
        void runTickSafely({ name: "reminder", logger }, () => runReminderTick(client, context))
    },
    // why: runHealthcheckTickPing は内部で失敗を握り潰す best-effort 実装のため runTickSafely で囲まない。
    // @see ADR-0034
    {
      schedule: HEALTHCHECK_PING_INTERVAL_CRON,
      tick: () => void runHealthcheckTickPing(deps.healthcheckUrl, deps.fetchFn)
    },
    // @see ADR-0035
    {
      schedule: CRON_OUTBOX_WORKER_SCHEDULE,
      tick: () =>
        void runTickSafely({ name: "outbox_worker", logger }, () =>
          runOutboxWorkerTick(client, context)
        )
    },
    // @see ADR-0042
    {
      schedule: CRON_OUTBOX_RETENTION_SCHEDULE,
      tick: () =>
        void runTickSafely({ name: "outbox_retention", logger }, () =>
          runOutboxRetentionTick(context)
        )
    },
    // @see ADR-0043
    {
      schedule: CRON_OUTBOX_METRICS_SCHEDULE,
      tick: () =>
        void runTickSafely({ name: "outbox_metrics", logger }, () =>
          runOutboxMetricsTick(context)
        )
    }
  ];

  return taskDefs.map((def) =>
    cronModule.schedule(def.schedule, def.tick, { timezone: "Asia/Tokyo", noOverlap: true })
  );
};
