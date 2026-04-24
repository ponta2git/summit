import { randomUUID } from "node:crypto";

import type { Client } from "discord.js";
import { type ResultAsync, okAsync, safeTry } from "neverthrow";

import type { AppContext } from "../../appContext.js";
import { MEMBER_COUNT_EXPECTED } from "../../config.js";
import type { ResponseRow, SessionRow } from "../../db/rows.js";
import {
  evaluatePostponeVote,
  type PostponeDecisionResult
} from "./decide.js";
import type { AppError } from "../../errors/index.js";
import { fromDatabasePromise, fromDiscordPromise } from "../../errors/result.js";
import { logger } from "../../logger.js";
import {
  deadlineFor,
  formatCandidateDateIso,
  parseCandidateDateIso,
  saturdayCandidateFrom
} from "../../time/index.js";
import { sendPostponedAskMessage } from "../ask-session/send.js";
import { updatePostponeMessage } from "./messageEditor.js";

const postponeDecisionFooter = (
  decision: Exclude<PostponeDecisionResult, { kind: "pending" }>
): string => {
  if (decision.kind === "all_ok") {
    return "順延されました";
  }
  return "この回はお流れになりました";
};

const evaluateVoteOutcome = (
  session: SessionRow,
  responses: readonly ResponseRow[],
  now: Date
): PostponeDecisionResult =>
  evaluatePostponeVote(session, responses, {
    memberCountExpected: MEMBER_COUNT_EXPECTED,
    now
  });

const applyDecidedOutcome = (
  client: Client,
  ctx: AppContext,
  current: SessionRow,
  responses: readonly ResponseRow[],
  decision: Extract<PostponeDecisionResult, { kind: "all_ok" }>,
  now: Date
): ResultAsync<void, AppError> =>
  safeTry(async function* () {
    const postponed = yield* fromDatabasePromise(
      ctx.ports.sessions.completePostponeVoting({
        id: current.id,
        now,
        outcome: "decided"
      }),
      "Failed to complete postpone voting (decided)."
    );
    // why: race-lost (CAS undefined) は無害な分岐として正常終了させる @see ADR-0001
    if (!postponed) {return okAsync(undefined);}

    logger.info(
      { sessionId: postponed.id, weekKey: postponed.weekKey, from: "POSTPONE_VOTING", to: "POSTPONED", reason: "all votes ok" },
      "Postpone voting decided; Saturday session will be created."
    );
    yield* fromDiscordPromise(
      updatePostponeMessage(client, ctx, postponed, responses, postponeDecisionFooter(decision)),
      "Failed to update postpone message after decided outcome."
    );

    const saturdayCandidate = saturdayCandidateFrom(parseCandidateDateIso(postponed.candidateDateIso));
    const saturdaySession = yield* fromDatabasePromise(
      ctx.ports.sessions.createAskSession({
        id: randomUUID(),
        weekKey: postponed.weekKey,
        postponeCount: 1,
        candidateDateIso: formatCandidateDateIso(saturdayCandidate),
        channelId: postponed.channelId,
        deadlineAt: deadlineFor(saturdayCandidate)
      }),
      "Failed to create Saturday postponed session."
    );
    if (!saturdaySession) {
      logger.info(
        { sessionId: postponed.id, weekKey: postponed.weekKey, reason: "saturday session already exists" },
        "Skipped creating postponed Saturday session."
      );
      return okAsync(undefined);
    }

    yield* fromDiscordPromise(
      sendPostponedAskMessage(client, ctx, saturdaySession),
      "Failed to send postponed Saturday ask message."
    );
    return okAsync(undefined);
  });

const applyCancelledOutcome = (
  client: Client,
  ctx: AppContext,
  current: SessionRow,
  responses: readonly ResponseRow[],
  decision: Exclude<PostponeDecisionResult, { kind: "pending" | "all_ok" }>,
  now: Date
): ResultAsync<void, AppError> =>
  safeTry(async function* () {
    const cancelled = yield* fromDatabasePromise(
      ctx.ports.sessions.completePostponeVoting({
        id: current.id,
        now,
        outcome: "cancelled_full",
        cancelReason: decision.reason
      }),
      "Failed to complete postpone voting (cancelled)."
    );
    if (!cancelled) {return okAsync(undefined);}

    logger.info(
      { sessionId: cancelled.id, weekKey: cancelled.weekKey, from: "POSTPONE_VOTING", to: "COMPLETED", reason: decision.reason },
      "Postpone voting cancelled."
    );
    yield* fromDiscordPromise(
      updatePostponeMessage(client, ctx, cancelled, responses, postponeDecisionFooter(decision)),
      "Failed to update postpone message after cancelled outcome."
    );
    return okAsync(undefined);
  });

/**
 * Settle a POSTPONE_VOTING session into its terminal outcome.
 *
 * @remarks
 * race: race-lost (CAS が undefined を返す) は `Ok(void)` として扱う。
 *   別経路が先に遷移済み = 正常な分岐であり、エラーではない (ADR-0001 DB-as-SoT)。
 * idempotent: 内部で CAS を使うため重複呼び出しは安全。
 */
export const settlePostponeVotingSession = (
  client: Client,
  ctx: AppContext,
  session: SessionRow,
  now: Date
): ResultAsync<void, AppError> =>
  safeTry(async function* () {
    const current = yield* fromDatabasePromise(
      ctx.ports.sessions.findSessionById(session.id),
      "Failed to load session for postpone settle."
    );
    if (!current || current.status !== "POSTPONE_VOTING") {
      return okAsync(undefined);
    }

    const responses = yield* fromDatabasePromise(
      ctx.ports.responses.listResponses(current.id),
      "Failed to load responses for postpone settle."
    );
    const decision = evaluateVoteOutcome(current, responses, now);
    if (decision.kind === "pending") {
      return okAsync(undefined);
    }

    if (decision.kind === "all_ok") {
      yield* applyDecidedOutcome(client, ctx, current, responses, decision, now);
      return okAsync(undefined);
    }

    yield* applyCancelledOutcome(client, ctx, current, responses, decision, now);
    return okAsync(undefined);
  });
