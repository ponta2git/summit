import type { Client } from "discord.js";

import type { AppContext } from "../appContext.js";
import { MEMBER_COUNT_EXPECTED } from "../config.js";
import type { SessionRow } from "../db/rows.js";
import type { AppError } from "../errors/index.js";
import { evaluateAndApplyDeadlineDecision, settlePostponeVotingSession } from "../orchestration/index.js";
import { sendReminderForSession } from "../features/reminder/send.js";
import { logger } from "../logger.js";

const logStartupSessionResultError = (
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

const settleStartupAskingSession = async (
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
    (error) => logStartupSessionResultError(error, session, "Startup recovery: failed to settle ASKING session.")
  );
};

/**
 * Re-settle overdue non-terminal sessions at process boot.
 *
 * @remarks
 * source-of-truth: DB の非終端 Session を走査し締切超過行を settle する。
 * idempotent: 各 settle は CAS 済みで再起動跨ぎの重複呼び出し安全。
 */
export const runStartupRecovery = async (
  client: Client,
  ctx: AppContext
): Promise<void> => {
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
        await settleStartupAskingSession(client, ctx, session, now);
      } else if (
        session.status === "POSTPONE_VOTING" &&
        session.deadlineAt.getTime() <= now.getTime()
      ) {
        logger.info(
          {
            sessionId: session.id,
            weekKey: session.weekKey,
            deadlineAt: session.deadlineAt.toISOString()
          },
          "Startup recovery: settling overdue POSTPONE_VOTING session."
        );
        await settlePostponeVotingSession(client, ctx, session, now).match(
          () => {},
          (error) =>
            logStartupSessionResultError(
              error,
              session,
              "Startup recovery: failed to settle POSTPONE_VOTING session."
            )
        );
      } else if (
        session.status === "DECIDED" &&
        session.reminderAt !== null &&
        session.reminderAt.getTime() <= now.getTime() &&
        session.reminderSentAt === null
      ) {
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
