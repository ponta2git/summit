import cron, { type ScheduledTask } from "node-cron";
import type { Client } from "discord.js";

import {
  CRON_ASK_SCHEDULE,
  CRON_DEADLINE_SCHEDULE,
  MEMBER_COUNT_EXPECTED
} from "../config.js";
import { db as defaultDb } from "../db/client.js";
import {
  findDueAskingSessions,
  findNonTerminalSessions,
  listResponses
} from "../db/repositories/index.js";
import type { DbLike, SessionRow } from "../db/types.js";
import {
  sendAskMessage,
  type SendAskMessageContext,
  type SendAskMessageResult
} from "../discord/ask/send.js";
import { evaluateAndApplyDeadlineDecision } from "../discord/settle.js";
import { logger } from "../logger.js";
import { systemClock, type Clock } from "../time/index.js";

type SendAsk = (context: SendAskMessageContext) => Promise<SendAskMessageResult>;

interface CronAdapter {
  schedule(
    expression: string,
    handler: () => void | Promise<void>,
    options: { timezone: string; noOverlap: boolean }
  ): ScheduledTask;
}

export interface AskSchedulerDeps {
  client: Client;
  sendAsk?: SendAsk;
  clock?: Clock;
  cronAdapter?: CronAdapter;
  db?: DbLike;
}

export const runScheduledAskTick = async (
  sendAsk: SendAsk,
  clock: Clock
): Promise<void> => {
  try {
    await sendAsk({ trigger: "cron", clock });
  } catch (error: unknown) {
    logger.error({ error }, "Scheduled /ask delivery failed.");
  }
};

/**
 * Evaluate a single ASKING session at the 21:30 deadline.
 * - all 4 members answered with time slots → DECIDED (no announcement in scope).
 * - otherwise → CANCELLED + postpone voting message.
 */
const settleDueAskingSession = async (
  client: Client,
  db: DbLike,
  session: SessionRow,
  now: Date
): Promise<void> => {
  const responses = await listResponses(db, session.id);
  await evaluateAndApplyDeadlineDecision(client, db, session, responses, {
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
  db: DbLike,
  clock: Clock
): Promise<void> => {
  try {
    const now = clock.now();
    const due = await findDueAskingSessions(db, now);
    for (const session of due) {
      await settleDueAskingSession(client, db, session, now);
    }
  } catch (error: unknown) {
    logger.error({ error }, "Deadline tick failed.");
  }
};

/**
 * Re-settles overdue ASKING sessions found in the DB at startup.
 *
 * @remarks
 * プロセス再起動で cron tick を取りこぼしても整合を回復させる入口。CAS 済みのため
 * 二重実行安全。非終端 Session を全件スキャンして締切超過のものだけ処理する。
 */
export const runStartupRecovery = async (
  client: Client,
  db: DbLike,
  clock: Clock
): Promise<void> => {
  // source-of-truth: 起動時に DB の非終端 Session を読み直し、締切超過していれば settleDueAskingSession を呼ぶ。
  //   プロセス再起動で cron tick を取りこぼしても整合を回復できる。
  // idempotent: settleAskingSession / tryDecideIfAllTimeSlots は CAS 済みのため二重呼び出し安全。
  try {
    const sessions = await findNonTerminalSessions(db);
    const now = clock.now();
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
        await settleDueAskingSession(client, db, session, now);
      }
    }
  } catch (error: unknown) {
    logger.error({ error }, "Startup recovery failed.");
  }
};

export interface SchedulerHandles {
  askTask: ScheduledTask;
  deadlineTask: ScheduledTask;
}

/**
 * Registers the /ask send and deadline cron tasks.
 *
 * @returns Handles to the scheduled tasks (for shutdown).
 *
 * @remarks
 * プロセス内で 1 度だけ呼ぶこと。複数インスタンスで同時駆動すると Discord への
 * 二重送信や race になる。Fly app は 1 インスタンス固定前提。
 *
 * @see docs/adr/0001-single-instance-db-as-source-of-truth.md
 */
export const createAskScheduler = (deps: AskSchedulerDeps): SchedulerHandles => {
  const clock = deps.clock ?? systemClock;
  const db = deps.db ?? defaultDb;
  const sendAsk =
    deps.sendAsk ??
    ((context: SendAskMessageContext) => sendAskMessage(deps.client, context));
  const cronModule = deps.cronAdapter ?? cron;

  // single-instance: node-cron はプロセスあたり 1 回だけ登録する。Fly app を 2 インスタンスにすると二重駆動する。
  // source-of-truth: cron tick は DB から再計算する。in-memory 状態に依存しない。
  // noOverlap: tick の実行が次 tick と重なる場合は後続をスキップ (長時間 tick 中の二重実行防止)。
  // why: runtime tunables を config.ts に集約 (ADR-0013)
  // invariant: ADR-0007 により暫定で金 08:00 JST を維持する。requirements/base.md の 18:00 記述は過渡期の未同期。
  // @see docs/adr/0001-single-instance-db-as-source-of-truth.md
  // @see docs/adr/0007-ask-command-always-available-and-08-jst-cron.md
  const askTask = cronModule.schedule(
    CRON_ASK_SCHEDULE,
    () => void runScheduledAskTick(sendAsk, clock),
    { timezone: "Asia/Tokyo", noOverlap: true }
  );

  // jst: 金曜 21:30 JST。candidateDateIso=当日 / deadlineAt=当日 21:30 の組に対応する。
  const deadlineTask = cronModule.schedule(
    CRON_DEADLINE_SCHEDULE,
    () => void runDeadlineTick(deps.client, db, clock),
    { timezone: "Asia/Tokyo", noOverlap: true }
  );

  return { askTask, deadlineTask };
};
