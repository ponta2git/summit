import cron, { type ScheduledTask } from "node-cron";
import type { Client } from "discord.js";

import type { AppContext } from "../appContext.js";
import {
  CRON_ASK_SCHEDULE,
  CRON_DEADLINE_SCHEDULE,
  CRON_POSTPONE_DEADLINE_SCHEDULE,
  CRON_REMINDER_SCHEDULE,
  HEALTHCHECK_PING_INTERVAL_CRON,
  HEALTHCHECK_PING_TIMEOUT_MS,
  MEMBER_COUNT_EXPECTED
} from "../config.js";
import type { SessionRow } from "../db/rows.js";
import { sendHealthcheckPing, type FetchFn } from "../healthcheck/ping.js";
import {
  sendAskMessage,
  type SendAskMessageContext,
  type SendAskMessageResult
} from "../features/ask-session/send.js";
import { evaluateAndApplyDeadlineDecision } from "../features/ask-session/settle.js"
import { sendReminderForSession } from "../features/reminder/send.js"
import { settlePostponeVotingSession } from "../features/postpone-voting/settle.js";
import { logger } from "../logger.js";
import { runReconciler } from "./reconciler.js";

type SendAsk = (context: SendAskMessageContext) => Promise<SendAskMessageResult>;

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
  /** Optional: `env.HEALTHCHECK_PING_URL`. No-op when undefined. */
  readonly healthcheckUrl?: string;
  /** Optional: injected fetch implementation for testing. */
  readonly fetchFn?: FetchFn;
}

export const runScheduledAskTick = async (
  sendAsk: SendAsk,
  context: AppContext
): Promise<void> => {
  try {
    await sendAsk({ trigger: "cron", context });
  } catch (error: unknown) {
    logger.error({ error }, "Scheduled /ask delivery failed.");
  }
};

/**
 * Evaluate a single ASKING session at the 21:30 deadline.
 */
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
  });
};

/**
 * Runs one deadline tick: settles every ASKING session whose deadline has passed.
 *
 * @remarks
 * cron (毎分) と起動時リカバリの双方から呼ばれる。例外は外に漏らさず log に集約する。
 */
export const runDeadlineTick = async (
  client: Client,
  ctx: AppContext
): Promise<void> => {
  try {
    const now = ctx.clock.now();
    const due = await ctx.ports.sessions.findDueAskingSessions(now);
    for (const session of due) {
      await settleDueAskingSession(client, ctx, session, now);
    }
  } catch (error: unknown) {
    logger.error({ error }, "Deadline tick failed.");
  }
};

/**
 * Runs one postpone-deadline tick: settles every POSTPONE_VOTING session whose deadline has passed.
 *
 * @remarks
 * 土 00:00 JST (POSTPONE_DEADLINE="24:00") の cron tick と起動時リカバリの双方から呼ばれる。
 * セッション単位で try/catch し、1 件の失敗が残りの処理を止めないよう冪等に続行する。
 * @see ADR-0001 single-instance-db-as-source-of-truth
 */
export const runPostponeDeadlineTick = async (
  client: Client,
  ctx: AppContext
): Promise<void> => {
  try {
    const now = ctx.clock.now();
    // source-of-truth: DB から期限切れ POSTPONE_VOTING セッションを再計算する。
    const due = await ctx.ports.sessions.findDuePostponeVotingSessions(now);
    for (const session of due) {
      try {
        // idempotent: settlePostponeVotingSession は内部で CAS を使うため、重複呼び出しは安全。
        await settlePostponeVotingSession(client, ctx, session, now);
      } catch (error: unknown) {
        logger.error(
          { error, sessionId: session.id, weekKey: session.weekKey },
          "Failed to settle POSTPONE_VOTING session in postpone deadline tick."
        );
      }
    }
  } catch (error: unknown) {
    logger.error({ error }, "Postpone deadline tick failed.");
  }
};

/**
 * Runs one reminder tick: sends the 15-minute-before reminder for every DECIDED session
 * whose `reminderAt` has passed and has not yet been sent (requirements/base.md §5.2, §9.1).
 *
 * @remarks
 * 毎分 cron tick から呼ばれる。送信後は DECIDED→COMPLETED へ遷移する。
 * 送信失敗時は DECIDED のまま据え置き、次 tick で再試行する (DB-as-SoT)。
 * @see docs/adr/0024-reminder-dispatch.md
 */
export const runReminderTick = async (
  client: Client,
  ctx: AppContext
): Promise<void> => {
  try {
    // invariant: 毎分 tick 境界で stale reminder claim を回収する (H1)。他の invariant は軽量に保つため起動時のみ。
    // @see docs/adr/0033-startup-invariant-reconciler.md
    await runReconciler(client, ctx, { scope: "tick" });
    const now = ctx.clock.now();
    const due = await ctx.ports.sessions.findDueReminderSessions(now);
    for (const session of due) {
      try {
        // idempotent: sendReminderForSession は内部で status/reminderSentAt を再検証する
        await sendReminderForSession(client, ctx, session.id, now);
      } catch (error: unknown) {
        logger.error(
          { error, sessionId: session.id, weekKey: session.weekKey },
          "Failed to dispatch reminder in reminder tick."
        );
      }
    }
  } catch (error: unknown) {
    logger.error({ error }, "Reminder tick failed.");
  }
};

/**
 * Fires a best-effort healthcheck ping on each minute cron tick.
 *
 * @remarks
 * No-op when `url` is `undefined` (i.e., `HEALTHCHECK_PING_URL` is not set).
 * Logs `event=healthcheck.tick_ping` with `ok`, `elapsedMs`, `status`/`errorKind`.
 * URL is never logged.
 * @see docs/adr/0034-healthcheck-ping.md
 */
export const runHealthcheckTickPing = async (
  url: string | undefined,
  fetchFn?: FetchFn
): Promise<void> => {
  if (!url) { return; }
  try {
    const result = await sendHealthcheckPing(url, {
      timeoutMs: HEALTHCHECK_PING_TIMEOUT_MS,
      ...(fetchFn !== undefined ? { fetchFn } : {})
    });
    if (result.ok) {
      logger.info(
        { event: "healthcheck.tick_ping", ok: true, elapsedMs: result.elapsedMs, status: result.status },
        "Healthcheck tick ping."
      );
    } else {
      const failFields =
        result.status !== undefined
          ? { event: "healthcheck.tick_ping", ok: false, elapsedMs: result.elapsedMs, status: result.status }
          : { event: "healthcheck.tick_ping", ok: false, elapsedMs: result.elapsedMs, errorKind: result.errorKind };
      logger.warn(failFields, "Healthcheck tick ping failed.");
    }
  } catch (error: unknown) {
    // sendHealthcheckPing should never throw; belt-and-suspenders guard.
    logger.warn({ event: "healthcheck.tick_ping", ok: false, error }, "Healthcheck tick ping threw unexpectedly.");
  }
};

/**
 * Re-settles overdue ASKING and POSTPONE_VOTING sessions found in the DB at startup.
 *
 * @remarks
 * プロセス再起動で cron tick を取りこぼしても整合を回復させる入口。CAS 済みのため
 * 二重実行安全。非終端 Session を全件スキャンして締切超過のものだけ処理する。
 */
export const runStartupRecovery = async (
  client: Client,
  ctx: AppContext
): Promise<void> => {
  // source-of-truth: 起動時に DB の非終端 Session を読み直し、締切超過していれば各 settle を呼ぶ。
  // idempotent: settle 関数はいずれも CAS 済みのため二重呼び出し安全。
  try {
    const sessions = await ctx.ports.sessions.findNonTerminalSessions();
    const now = ctx.clock.now();
    for (const session of sessions) {
      if (session.status === "ASKING" && session.deadlineAt.getTime() <= now.getTime()) {
        logger.info(
          {
            sessionId: session.id,
            weekKey: session.weekKey,
            deadlineAt: session.deadlineAt.toISOString()
          },
          "Startup recovery: settling overdue ASKING session."
        );
        await settleDueAskingSession(client, ctx, session, now);
      } else if (
        session.status === "POSTPONE_VOTING" &&
        session.deadlineAt.getTime() <= now.getTime()
      ) {
        // state: POSTPONE_VOTING かつ deadlineAt 超過のセッションを順延期限切れとして決着させる。
        logger.info(
          {
            sessionId: session.id,
            weekKey: session.weekKey,
            deadlineAt: session.deadlineAt.toISOString()
          },
          "Startup recovery: settling overdue POSTPONE_VOTING session."
        );
        await settlePostponeVotingSession(client, ctx, session, now);
      } else if (
        session.status === "DECIDED" &&
        session.reminderAt !== null &&
        session.reminderAt.getTime() <= now.getTime() &&
        session.reminderSentAt === null
      ) {
        // state: DECIDED かつ reminderAt 超過で未送信なら起動時に即リマインド送信を試みる
        logger.info(
          {
            sessionId: session.id,
            weekKey: session.weekKey,
            reminderAt: session.reminderAt.toISOString()
          },
          "Startup recovery: dispatching overdue reminder."
        );
        await sendReminderForSession(client, ctx, session.id, now);
      }
    }
  } catch (error: unknown) {
    logger.error({ error }, "Startup recovery failed.");
  }
};

/**
 * Registers all scheduled cron tasks.
 *
 * @remarks
 * プロセス内で 1 度だけ呼ぶこと。複数インスタンスで同時駆動すると Discord への
 * 二重送信や race になる。Fly app は 1 インスタンス固定前提。
 * 戻り値は登録順の ScheduledTask 配列。shutdown 時は `for (const t of ...) t.stop()`。
 *
 * @see docs/adr/0001-single-instance-db-as-source-of-truth.md
 */
export const createAskScheduler = (deps: AskSchedulerDeps): readonly ScheduledTask[] => {
  const { context, client } = deps;
  const sendAsk =
    deps.sendAsk ?? ((sendContext: SendAskMessageContext) => sendAskMessage(client, sendContext));
  const cronModule = deps.cronAdapter ?? cron;

  // single-instance: node-cron はプロセスあたり 1 回だけ登録する。Fly app を 2 インスタンスにすると二重駆動する。
  // source-of-truth: cron tick は DB から再計算する。in-memory 状態に依存しない。
  // noOverlap: tick の実行が次 tick と重なる場合は後続をスキップ (長時間 tick 中の二重実行防止)。
  // why: registry 化により feature 追加時の scheduler 変更箇所を 1 行に限定する。
  //   各 tick の意味論 (cron 式と JST 前提) は config.ts 側の CRON_* 定数に集約。
  const taskDefs: ReadonlyArray<{ readonly schedule: string; readonly tick: () => void }> = [
    // ADR-0007: /ask 送信スケジュール (金曜朝)。
    { schedule: CRON_ASK_SCHEDULE, tick: () => void runScheduledAskTick(sendAsk, context) },
    // 金曜 21:30 JST。candidateDateIso=当日 / deadlineAt=当日 21:30 の組に対応する。
    { schedule: CRON_DEADLINE_SCHEDULE, tick: () => void runDeadlineTick(client, context) },
    // 土曜 00:00 JST = POSTPONE_DEADLINE="24:00"（候補日翌日 00:00 JST）。
    {
      schedule: CRON_POSTPONE_DEADLINE_SCHEDULE,
      tick: () => void runPostponeDeadlineTick(client, context)
    },
    // 毎分 tick。DECIDED かつ reminderAt 到来のセッションにリマインド送信する (§5.2, §9.1)。
    { schedule: CRON_REMINDER_SCHEDULE, tick: () => void runReminderTick(client, context) },
    // 毎分 tick。healthchecks.io に死活監視 ping を送る (ADR-0034)。URL 未設定時は no-op。
    {
      schedule: HEALTHCHECK_PING_INTERVAL_CRON,
      tick: () => void runHealthcheckTickPing(deps.healthcheckUrl, deps.fetchFn)
    }
  ];

  return taskDefs.map((def) =>
    cronModule.schedule(def.schedule, def.tick, { timezone: "Asia/Tokyo", noOverlap: true })
  );
};
