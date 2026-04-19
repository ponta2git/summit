import cron, { type ScheduledTask } from "node-cron";
import type { Client } from "discord.js";

import { db as defaultDb } from "../db/client.js";
import {
  findDueAskingSessions,
  findNonTerminalSessions,
  listResponses,
  type DbLike,
  type SessionRow
} from "../db/repositories/sessions.js";
import {
  sendAskMessage,
  type SendAskMessageContext,
  type SendAskMessageResult
} from "../discord/askMessage.js";
import { settleAskingSession, tryDecideIfAllTimeSlots } from "../discord/settle.js";
import { env } from "../env.js";
import { logger } from "../logger.js";
import {
  decidedStartAt,
  parseCandidateDateIso,
  systemClock,
  type AskTimeChoice,
  type Clock
} from "../time/index.js";

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
const settleAtDeadline = async (
  client: Client,
  db: DbLike,
  session: SessionRow
): Promise<void> => {
  const responses = await listResponses(db, session.id);
  const expected = env.MEMBER_USER_IDS.length;

  const hasAbsent = responses.some((r) => r.choice === "ABSENT");
  const allAnswered = responses.length === expected;
  const allTime =
    allAnswered &&
    responses.every(
      (r) =>
        r.choice === "T2200" ||
        r.choice === "T2230" ||
        r.choice === "T2300" ||
        r.choice === "T2330"
    );

  if (hasAbsent) {
    // Absent case should already have triggered settleAskingSession from
    // the button handler, but if we somehow reach here, settle now.
    await settleAskingSession(client, db, session.id, "absent");
    return;
  }

  if (allTime) {
    const timeChoices = responses
      .map((r) => r.choice)
      .filter(
        (c): c is AskTimeChoice =>
          c === "T2200" || c === "T2230" || c === "T2300" || c === "T2330"
      );
    const start = decidedStartAt(parseCandidateDateIso(session.candidateDate), timeChoices);
    if (start) {
      await tryDecideIfAllTimeSlots(db, session, start);
    }
    return;
  }

  await settleAskingSession(client, db, session.id, "deadline_unanswered");
};

export const runDeadlineTick = async (
  client: Client,
  db: DbLike,
  clock: Clock
): Promise<void> => {
  try {
    const due = await findDueAskingSessions(db, clock.now());
    for (const session of due) {
      await settleAtDeadline(client, db, session);
    }
  } catch (error: unknown) {
    logger.error({ error }, "Deadline tick failed.");
  }
};

export const runStartupRecovery = async (
  client: Client,
  db: DbLike,
  clock: Clock
): Promise<void> => {
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
        await settleAtDeadline(client, db, session);
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

export const createAskScheduler = (deps: AskSchedulerDeps): SchedulerHandles => {
  const clock = deps.clock ?? systemClock;
  const db = deps.db ?? defaultDb;
  const sendAsk =
    deps.sendAsk ??
    ((context: SendAskMessageContext) => sendAskMessage(deps.client, context));
  const cronModule = deps.cronAdapter ?? cron;

  const askTask = cronModule.schedule(
    "0 8 * * 5",
    () => void runScheduledAskTick(sendAsk, clock),
    { timezone: "Asia/Tokyo", noOverlap: true }
  );

  const deadlineTask = cronModule.schedule(
    "30 21 * * 5",
    () => void runDeadlineTick(deps.client, db, clock),
    { timezone: "Asia/Tokyo", noOverlap: true }
  );

  return { askTask, deadlineTask };
};
