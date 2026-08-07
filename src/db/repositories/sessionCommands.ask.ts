import { eq, sql } from "drizzle-orm";

import { sessions } from "../schema.js";
import type { DbLike, SessionRow } from "../rows.js";
import { evaluateDeadline } from "../../domain/askDecision.js";
import {
  parseCandidateDateIso,
  postponeDeadlineFor,
  reminderAtFor
} from "../../time/index.js";
import { mapSession } from "./sessions.internal.js";
import {
  buildDecidedAnnouncementIntent,
  buildPostponeVoteIntent,
  buildSettleNoticeIntent,
  type AskCancellationReason
} from "./sessionOutboxIntents.js";
import {
  bumpSessionRevision,
  enqueueSessionIntents,
  listLockedResponses,
  lockSession,
  memberExists,
  upsertInteractionResponse,
  type DbTransaction
} from "./sessionCommands.shared.js";
import type {
  AskingDeadlineResult,
  SettleAskingCancellationInput,
  SettleAskingCancellationResult,
  SettleDeadlineInput,
  SubmitAskResponseInput,
  SubmitAskResponseResult
} from "./sessionCommands.types.js";

const resolveCancellationReason = (
  session: SessionRow,
  requested: AskCancellationReason
): AskCancellationReason =>
  session.postponeCount === 1
    ? "saturday_cancelled"
    : requested === "absent"
      ? "absent"
      : "deadline_unanswered";

const applyAskCancellation = async (
  tx: DbTransaction,
  current: SessionRow,
  requestedReason: AskCancellationReason,
  now: Date
): Promise<SessionRow> => {
  const reason = resolveCancellationReason(current, requestedReason);
  let cancelled = current;
  if (current.status === "ASKING") {
    const rows = await tx
      .update(sessions)
      .set({
        status: "CANCELLED",
        cancelReason: reason,
        revision: sql`${sessions.revision} + 1`,
        updatedAt: now
      })
      .where(eq(sessions.id, current.id))
      .returning();
    if (!rows[0]) {throw new Error("locked ask session disappeared");}
    cancelled = mapSession(rows[0]);
  } else if (current.status !== "CANCELLED") {
    throw new Error(`cannot cancel ask session from ${current.status}`);
  }

  const postponeDeadline = postponeDeadlineFor(
    parseCandidateDateIso(cancelled.candidateDateIso)
  );
  const startsPostponeVote =
    cancelled.postponeCount === 0 && now.getTime() < postponeDeadline.getTime();
  const finalRows = await tx
    .update(sessions)
    .set({
      status: startsPostponeVote ? "POSTPONE_VOTING" : "COMPLETED",
      cancelReason: reason,
      ...(startsPostponeVote ? { deadlineAt: postponeDeadline } : {}),
      revision: sql`${sessions.revision} + 1`,
      updatedAt: now
    })
    .where(eq(sessions.id, cancelled.id))
    .returning();
  if (!finalRows[0]) {throw new Error("locked cancelled session disappeared");}
  const settled = mapSession(finalRows[0]);
  const intents = [
    buildSettleNoticeIntent(settled, reason, {
      forceSuppressMentions: startsPostponeVote,
      ordinal: 0
    }),
    ...(startsPostponeVote ? [buildPostponeVoteIntent(settled, 1)] : [])
  ];
  await enqueueSessionIntents(tx, intents);
  return settled;
};

export const submitAskResponse = async (
  db: DbLike,
  input: SubmitAskResponseInput
): Promise<SubmitAskResponseResult> =>
  db.transaction(async (tx) => {
    const current = await lockSession(tx, input.sessionId);
    if (!current) {return { kind: "session_not_found" };}
    if (current.status !== "ASKING") {return { kind: "closed", session: current };}
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
    if (input.choice !== "ABSENT") {
      const bumped = await bumpSessionRevision(tx, current, input.now);
      return {
        kind: "accepted_pending",
        session: bumped,
        response: saved.response
      };
    }

    return {
      kind: "transitioned",
      outcome: "cancelled",
      session: await applyAskCancellation(tx, current, "absent", input.now),
      response: saved.response
    };
  });

export const settleAskingCancellation = async (
  db: DbLike,
  input: SettleAskingCancellationInput
): Promise<SettleAskingCancellationResult> =>
  db.transaction(async (tx) => {
    const current = await lockSession(tx, input.sessionId);
    if (!current) {return { kind: "session_not_found" };}
    if (current.status !== "ASKING" && current.status !== "CANCELLED") {
      return { kind: "closed", session: current };
    }
    return {
      kind: "transitioned",
      session: await applyAskCancellation(tx, current, input.reason, input.now)
    };
  });

export const settleAskingDeadline = async (
  db: DbLike,
  input: SettleDeadlineInput
): Promise<AskingDeadlineResult> =>
  db.transaction(async (tx) => {
    const current = await lockSession(tx, input.sessionId);
    if (!current) {return { kind: "session_not_found" };}
    if (current.status !== "ASKING") {return { kind: "closed", session: current };}

    const responseRows = await listLockedResponses(tx, current.id);
    const decision = evaluateDeadline(current, responseRows, {
      memberCountExpected: input.memberCountExpected,
      now: input.now
    });
    if (decision.kind === "pending") {
      return { kind: "not_due", session: current };
    }

    if (decision.kind === "cancelled") {
      const reason = decision.reason === "all_absent" ? "absent" : "deadline_unanswered";
      return {
        kind: "transitioned",
        outcome: "cancelled",
        session: await applyAskCancellation(tx, current, reason, input.now),
        responses: responseRows
      };
    }
    const rows = await tx
      .update(sessions)
      .set({
        status: "DECIDED",
        decidedStartAt: decision.startAt,
        reminderAt: reminderAtFor(decision.startAt),
        revision: sql`${sessions.revision} + 1`,
        updatedAt: input.now
      })
      .where(eq(sessions.id, current.id))
      .returning();
    if (!rows[0]) {throw new Error("locked ask session disappeared");}
    const decided = mapSession(rows[0]);
    await enqueueSessionIntents(tx, [
      buildDecidedAnnouncementIntent(decided)
    ]);
    return {
      kind: "transitioned",
      outcome: "decided",
      session: decided,
      responses: responseRows
    };
  });
