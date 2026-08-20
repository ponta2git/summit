import type { Client } from "discord.js";

import type { AppContext } from "../appContext.ts";
import { MEMBER_COUNT_EXPECTED } from "../config.ts";
import type { SessionRow } from "../db/rows.ts";
import { fromAppCall, fromDatabaseCall, mapDatabaseError } from "../errors/result.ts";
import { evaluateAndApplyDeadlineDecision, settlePostponeVotingSession } from "../orchestration/index.ts";
import { sendReminderForSession } from "../features/reminder/send.ts";
import { logger } from "../logger.ts";
import {
  runSchedulerBatchResult,
  type SchedulerBatchReport,
  type SchedulerFailure,
  type SchedulerResult
} from "./scheduler.types.ts";

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
    () => ctx.ports.sessions.findDueStartupRecoverySessions(now),
    "Failed to find due sessions for startup recovery."
  ).andThen((due) => {
    return runSchedulerBatchResult(
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
          mapDatabaseError("Failed to enqueue startup reminder.")
        );
      },
      (session) => ({ sessionId: session.id, weekKey: session.weekKey }),
      logSchedulerFailure
    );
  });
};
