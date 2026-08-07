import type { Client } from "discord.js";
import { ResultAsync } from "neverthrow";

import type { AppContext } from "../appContext.js";
import { MEMBER_COUNT_EXPECTED } from "../config.js";
import type { SessionRow } from "../db/rows.js";
import { DatabaseError, type AppError } from "../errors/index.js";
import { fromAppCall, fromDatabaseCall } from "../errors/result.js";
import { evaluateAndApplyDeadlineDecision, settlePostponeVotingSession } from "../orchestration/index.js";
import { sendReminderForSession } from "../features/reminder/send.js";
import { logger } from "../logger.js";
import {
  runSchedulerBatch,
  type SchedulerBatchReport,
  type SchedulerFailure,
  type SchedulerResult
} from "./scheduler.types.js";

const logSchedulerFailure = (failure: SchedulerFailure): void => {
  logger.error(
    {
      error: failure.error,
      errorCode: failure.error.code,
      phase: failure.phase,
      ...(failure.sessionId === undefined ? {} : { sessionId: failure.sessionId }),
      ...(failure.weekKey === undefined ? {} : { weekKey: failure.weekKey })
    },
    "Startup recovery operation failed for a session."
  );
};

const settleStartupAskingSession = (
  client: Client,
  ctx: AppContext,
  session: SessionRow,
  now: Date
): SchedulerResult<void> =>
  evaluateAndApplyDeadlineDecision(client, ctx, session, {
    memberCountExpected: MEMBER_COUNT_EXPECTED,
    now
  });

const mapReminderError = (cause: unknown): AppError =>
  new DatabaseError("Failed to enqueue startup reminder.", { cause });

/**
 * Re-settle overdue non-terminal sessions at process boot.
 *
 * @remarks
 * source-of-truth: DB の非終端 Session を走査し締切超過行を settle する。
 * idempotent: 各 settle は CAS 済みで再起動跨ぎの重複呼び出し安全。
 */
export const runStartupRecovery = (
  client: Client,
  ctx: AppContext
): SchedulerResult<SchedulerBatchReport> => {
  const now = ctx.clock.now();
  return fromDatabaseCall(
    () => ctx.ports.sessions.findNonTerminalSessions(),
    "Failed to find non-terminal sessions for startup recovery."
  ).andThen((sessions) => {
    const due = sessions.filter((session) =>
      (session.status === "ASKING" || session.status === "POSTPONE_VOTING") &&
        session.deadlineAt.getTime() <= now.getTime() ||
      session.status === "DECIDED" &&
        session.reminderAt !== null &&
        session.reminderAt.getTime() <= now.getTime() &&
        session.reminderSentAt === null
    );
    return ResultAsync.fromThrowable(
      () => runSchedulerBatch(
        "startup_recovery",
        due,
        (session) => {
          if (session.status === "ASKING") {
            logger.info(
              { sessionId: session.id, weekKey: session.weekKey, deadlineAt: session.deadlineAt.toISOString() },
              "Startup recovery: settling overdue ASKING session."
            );
            return settleStartupAskingSession(client, ctx, session, now);
          }
          if (session.status === "POSTPONE_VOTING") {
            logger.info(
              { sessionId: session.id, weekKey: session.weekKey, deadlineAt: session.deadlineAt.toISOString() },
              "Startup recovery: settling overdue POSTPONE_VOTING session."
            );
            return settlePostponeVotingSession(client, ctx, session, now);
          }
          logger.info(
            { sessionId: session.id, weekKey: session.weekKey, reminderAt: session.reminderAt?.toISOString() },
            "Startup recovery: dispatching overdue reminder."
          );
          return fromAppCall(
            () => sendReminderForSession(client, ctx, session.id, now),
            mapReminderError
          );
        },
        (session) => ({ sessionId: session.id, weekKey: session.weekKey }),
        logSchedulerFailure
      ),
      (cause) => new DatabaseError("Startup recovery batch failed.", { cause })
    )();
  });
};
