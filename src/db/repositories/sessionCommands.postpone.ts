import type { DbLike } from "../rows.js";
import { evaluatePostponeVote } from "../../domain/postponeDecision.js";
import {
  applyPostponeDecision,
  bumpSessionRevision,
  listLockedResponses,
  lockSession,
  memberExists,
  upsertInteractionResponse
} from "./sessionCommands.shared.js";
import type {
  SettlePostponeVotingInput,
  SettlePostponeVotingResult,
  SubmitPostponeVoteInput,
  SubmitPostponeVoteResult
} from "./sessionCommands.types.js";

export const submitPostponeVote = async (
  db: DbLike,
  input: SubmitPostponeVoteInput
): Promise<SubmitPostponeVoteResult> =>
  db.transaction(async (tx) => {
    const current = await lockSession(tx, input.sessionId);
    if (!current) {return { kind: "session_not_found" };}
    if (current.status !== "POSTPONE_VOTING") {
      return { kind: "closed", session: current };
    }
    if (input.now.getTime() >= current.deadlineAt.getTime()) {
      return { kind: "deadline_passed", session: current };
    }
    if (!(await memberExists(tx, input.memberId))) {
      return { kind: "member_not_found", session: current };
    }

    const saved = await upsertInteractionResponse(tx, {
      id: input.responseId,
      sessionId: input.sessionId,
      memberId: input.memberId,
      choice: input.choice,
      answeredAt: input.now,
      sourceInteractionId: input.sourceInteractionId
    });
    if (saved.kind === "stale") {
      return {
        kind: "stale_interaction",
        session: current,
        response: saved.response
      };
    }

    const responseRows = await listLockedResponses(tx, current.id);
    const decision = evaluatePostponeVote(current, responseRows, {
      memberCountExpected: input.memberCountExpected,
      now: input.now
    });
    if (decision.kind === "pending") {
      return {
        kind: "accepted_pending",
        session: await bumpSessionRevision(tx, current, input.now),
        response: saved.response
      };
    }
    return {
      kind: "transitioned",
      response: saved.response,
      ...(await applyPostponeDecision(
        tx,
        current,
        decision,
        input.saturday,
        input.now
      ))
    };
  });

export const settlePostponeVoting = async (
  db: DbLike,
  input: SettlePostponeVotingInput
): Promise<SettlePostponeVotingResult> =>
  db.transaction(async (tx) => {
    const current = await lockSession(tx, input.sessionId);
    if (!current) {return { kind: "session_not_found" };}
    if (current.status !== "POSTPONE_VOTING") {
      return { kind: "closed", session: current };
    }
    const responseRows = await listLockedResponses(tx, current.id);
    const decision = evaluatePostponeVote(current, responseRows, {
      memberCountExpected: input.memberCountExpected,
      now: input.now
    });
    if (decision.kind === "pending") {
      return { kind: "not_due", session: current };
    }
    return {
      kind: "transitioned",
      ...(await applyPostponeDecision(
        tx,
        current,
        decision,
        input.saturday,
        input.now
      ))
    };
  });
