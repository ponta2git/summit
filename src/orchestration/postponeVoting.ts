import { randomUUID } from "node:crypto";

import type { Client } from "discord.js";
import { type ResultAsync, okAsync, safeTry } from "neverthrow";

import type { AppContext } from "../appContext.ts";
import { MEMBER_COUNT_EXPECTED } from "../config.ts";
import type {
  PostponeTransitionOutcome,
  SaturdaySessionInput
} from "../db/repositories/sessionCommands.ts";
import type { SessionRow } from "../db/rows.ts";
import type { AppError } from "../errors/index.ts";
import { fromDatabasePromise } from "../errors/result.ts";
import { updatePostponeMessage } from "../features/postpone-voting/messageEditor.ts";
import { logger } from "../logger.ts";
import {
  deadlineFor,
  formatCandidateDateIso,
  parseCandidateDateIso,
  saturdayCandidateFrom
} from "../time/index.ts";

type PersistedPostponeTransition = {
  readonly kind: "transitioned";
} & PostponeTransitionOutcome;

export const buildSaturdaySessionInput = (
  session: SessionRow
): SaturdaySessionInput => {
  const candidate = saturdayCandidateFrom(
    parseCandidateDateIso(session.candidateDateIso)
  );
  return {
    id: randomUUID(),
    candidateDateIso: formatCandidateDateIso(candidate),
    deadlineAt: deadlineFor(candidate)
  };
};

const decisionFooter = (outcome: PostponeTransitionOutcome["outcome"]): string =>
  outcome === "all_ok"
    ? "明日の出欠確認へ進みます"
    : "この回はお流れになりました";

/**
 * Reflect one already-persisted postpone transition to Discord.
 *
 * @remarks
 * Parent POSTPONED + Saturday ASKING + Saturday ask intent are committed atomically before
 * this function runs. This function only repaints the existing parent message.
 */
export const applyPostponeTransitionResult = (
  client: Client,
  ctx: AppContext,
  result: PersistedPostponeTransition
): ResultAsync<void, AppError> =>
  safeTry(async function* () {
    const responseRows = yield* fromDatabasePromise(
      ctx.ports.responses.listResponses(result.session.id),
      "Failed to load responses for postpone message reflection."
    );
    yield* updatePostponeMessage(
      client,
      ctx,
      result.session,
      responseRows,
      decisionFooter(result.outcome)
    );

    if (result.outcome === "cancelled") {
      logger.info(
        {
          sessionId: result.session.id,
          weekKey: result.session.weekKey,
          from: "POSTPONE_VOTING",
          to: "COMPLETED",
          reason: result.session.cancelReason
        },
        "Postpone voting cancelled."
      );
      return okAsync(undefined);
    }

    logger.info(
      {
        sessionId: result.session.id,
        weekKey: result.session.weekKey,
        from: "POSTPONE_VOTING",
        to: "POSTPONED",
        reason: "all votes ok",
        saturdaySessionId: result.saturdaySession.id
      },
      "Postpone voting decided with Saturday session."
    );
    return okAsync(undefined);
  });

/**
 * Settle a POSTPONE_VOTING aggregate from one locked Session/Response snapshot.
 */
export const settlePostponeVotingSession = (
  client: Client,
  ctx: AppContext,
  session: SessionRow,
  now: Date
): ResultAsync<void, AppError> =>
  fromDatabasePromise(
    ctx.ports.sessionCommands.settlePostponeVoting({
      sessionId: session.id,
      now,
      memberCountExpected: MEMBER_COUNT_EXPECTED,
      saturday: buildSaturdaySessionInput(session)
    }),
    "Failed to settle POSTPONE_VOTING aggregate."
  ).andThen((result) =>
    result.kind === "transitioned"
      ? applyPostponeTransitionResult(client, ctx, result)
      : okAsync(undefined)
  );
