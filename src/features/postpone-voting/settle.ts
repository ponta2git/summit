import { randomUUID } from "node:crypto";

import type { Client } from "discord.js";

import type { AppContext } from "../../appContext.js";
import { MEMBER_COUNT_EXPECTED } from "../../config.js";
import type { ResponseRow, SessionRow } from "../../db/rows.js";
import {
  evaluatePostponeVote,
  type PostponeDecisionResult
} from "./decide.js";
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

const applyDecidedOutcome = async (
  client: Client,
  ctx: AppContext,
  current: SessionRow,
  responses: readonly ResponseRow[],
  decision: Extract<PostponeDecisionResult, { kind: "all_ok" }>,
  now: Date
): Promise<void> => {
  const postponed = await ctx.ports.sessions.completePostponeVoting({
    id: current.id,
    now,
    outcome: "decided"
  });
  if (!postponed) {return;}
  await updatePostponeMessage(client, ctx, postponed, responses, postponeDecisionFooter(decision));

  const saturdayCandidate = saturdayCandidateFrom(parseCandidateDateIso(postponed.candidateDateIso));
  const saturdaySession = await ctx.ports.sessions.createAskSession({
    id: randomUUID(),
    weekKey: postponed.weekKey,
    postponeCount: 1,
    candidateDateIso: formatCandidateDateIso(saturdayCandidate),
    channelId: postponed.channelId,
    deadlineAt: deadlineFor(saturdayCandidate)
  });
  if (!saturdaySession) {
    logger.info(
      { sessionId: postponed.id, weekKey: postponed.weekKey, reason: "saturday session already exists" },
      "Skipped creating postponed Saturday session."
    );
    return;
  }

  await sendPostponedAskMessage(client, ctx, saturdaySession);
};

const applyCancelledOutcome = async (
  client: Client,
  ctx: AppContext,
  current: SessionRow,
  responses: readonly ResponseRow[],
  decision: Exclude<PostponeDecisionResult, { kind: "pending" | "all_ok" }>,
  now: Date
): Promise<void> => {
  const cancelled = await ctx.ports.sessions.completePostponeVoting({
    id: current.id,
    now,
    outcome: "cancelled_full",
    cancelReason: decision.reason
  });
  if (!cancelled) {return;}
  await updatePostponeMessage(client, ctx, cancelled, responses, postponeDecisionFooter(decision));
};

export async function settlePostponeVotingSession(
  client: Client,
  ctx: AppContext,
  session: SessionRow,
  now: Date,
): Promise<void> {
  const current = await ctx.ports.sessions.findSessionById(session.id);
  if (!current || current.status !== "POSTPONE_VOTING") {
    return;
  }

  const responses = await ctx.ports.responses.listResponses(current.id);
  const decision = evaluateVoteOutcome(current, responses, now);
  if (decision.kind === "pending") {
    return;
  }

  if (decision.kind === "all_ok") {
    await applyDecidedOutcome(client, ctx, current, responses, decision, now);
    return;
  }

  await applyCancelledOutcome(client, ctx, current, responses, decision, now);
}
