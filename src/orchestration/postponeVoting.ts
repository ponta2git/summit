import { randomUUID } from "node:crypto";

import type { Client } from "discord.js";
import * as Effect from "effect/Effect";

import type { AppContext } from "../appContext.ts";
import { MEMBER_COUNT_EXPECTED } from "../config.ts";
import type {
  PostponeTransitionOutcome,
  SaturdaySessionInput
} from "../db/repositories/sessionCommands.ts";
import type { SessionRow } from "../db/rows.ts";
import type { AppError } from "../errors/index.ts";
import { fromDatabaseCall } from "../errors/effect.ts";
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

/**
 * Reflect one already-persisted postpone transition to Discord.
 *
 * @remarks
 * Parent POSTPONED + Saturday ASKING + Saturday ask intent are committed atomically before
 * this function runs. This function only repaints the existing parent message.
 */
export const applyPostponeTransition = (
  client: Client,
  ctx: AppContext,
  result: PersistedPostponeTransition
): Effect.Effect<void, AppError> =>
  Effect.gen(function* () {
    yield* updatePostponeMessage(client, ctx, result.session);

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
      return;
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
  });

/**
 * Settle a POSTPONE_VOTING aggregate from one locked Session/Response snapshot.
 */
export const settlePostponeVotingSession = (
  client: Client,
  ctx: AppContext,
  session: SessionRow,
  now: Date
): Effect.Effect<void, AppError> =>
  fromDatabaseCall(
    () => ctx.ports.sessionCommands.settlePostponeVoting({
      sessionId: session.id,
      now,
      memberCountExpected: MEMBER_COUNT_EXPECTED,
      saturday: buildSaturdaySessionInput(session)
    }),
    "Failed to settle POSTPONE_VOTING aggregate."
  ).pipe(Effect.flatMap((result) =>
    result.kind === "transitioned"
      ? applyPostponeTransition(client, ctx, result)
      : Effect.void
  ));
