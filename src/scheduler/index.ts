import cron, { type ScheduledTask } from "node-cron";
import type { Client } from "discord.js";

import type { AppContext } from "../composition.js";
import {
  CRON_ASK_SCHEDULE,
  CRON_DEADLINE_SCHEDULE,
  CRON_POSTPONE_DEADLINE_SCHEDULE,
  MEMBER_COUNT_EXPECTED
} from "../config.js";
import type { SessionRow } from "../db/types.js";
import {
  sendAskMessage,
  type SendAskMessageContext,
  type SendAskMessageResult
} from "../discord/ask/send.js";
import { evaluateAndApplyDeadlineDecision, settlePostponeVotingSession } from "../discord/settle/index.js";
import { logger } from "../logger.js";

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
      }
    }
  } catch (error: unknown) {
    logger.error({ error }, "Startup recovery failed.");
  }
};

export interface SchedulerHandles {
  askTask: ScheduledTask;
  deadlineTask: ScheduledTask;
  postponeDeadlineTask: ScheduledTask;
}

/**
 * Registers the /ask send, deadline, and postpone-deadline cron tasks.
 *
 * @remarks
 * プロセス内で 1 度だけ呼ぶこと。複数インスタンスで同時駆動すると Discord への
 * 二重送信や race になる。Fly app は 1 インスタンス固定前提。
 *
 * @see docs/adr/0001-single-instance-db-as-source-of-truth.md
 */
export const createAskScheduler = (deps: AskSchedulerDeps): SchedulerHandles => {
  const { context, client } = deps;
  const sendAsk =
    deps.sendAsk ?? ((sendContext: SendAskMessageContext) => sendAskMessage(client, sendContext));
  const cronModule = deps.cronAdapter ?? cron;

  // single-instance: node-cron はプロセスあたり 1 回だけ登録する。Fly app を 2 インスタンスにすると二重駆動する。
  // source-of-truth: cron tick は DB から再計算する。in-memory 状態に依存しない。
  // noOverlap: tick の実行が次 tick と重なる場合は後続をスキップ (長時間 tick 中の二重実行防止)。
  // why: 暫定スケジュール採用の根拠 → ADR-0007（値は CRON_ASK_SCHEDULE 参照）
  const askTask = cronModule.schedule(
    CRON_ASK_SCHEDULE,
    () => void runScheduledAskTick(sendAsk, context),
    { timezone: "Asia/Tokyo", noOverlap: true }
  );

  // jst: 金曜 21:30 JST。candidateDateIso=当日 / deadlineAt=当日 21:30 の組に対応する。
  const deadlineTask = cronModule.schedule(
    CRON_DEADLINE_SCHEDULE,
    () => void runDeadlineTick(client, context),
    { timezone: "Asia/Tokyo", noOverlap: true }
  );

  // jst: 土曜 00:00 JST = POSTPONE_DEADLINE="24:00"（候補日翌日 00:00 JST）。
  const postponeDeadlineTask = cronModule.schedule(
    CRON_POSTPONE_DEADLINE_SCHEDULE,
    () => void runPostponeDeadlineTick(client, context),
    { timezone: "Asia/Tokyo", noOverlap: true }
  );

  return { askTask, deadlineTask, postponeDeadlineTask };
};
