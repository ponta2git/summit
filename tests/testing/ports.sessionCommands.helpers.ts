import type {
  MembersPort,
  ResponseChoice,
  ResponseRow,
  SessionRow,
  SettlePostponeVotingInput,
  SubmitPostponeVoteInput
} from "../../src/db/ports.js";
import type { PostponeDecisionResult } from "../../src/domain/postponeDecision.js";
import {
  parseCandidateDateIso,
  postponeDeadlineFor
} from "../../src/time/index.js";
import {
  buildAskBodyIntent,
  buildPostponeVoteIntent,
  buildSettleNoticeIntent,
  type AskCancellationReason
} from "../../src/db/repositories/sessionOutboxIntents.js";
import type { FakeOutboxPort } from "./ports.outbox.ts";
import type { FakeResponsesPort } from "./ports.responses.js";
import type { FakeSessionsPort } from "./ports.sessions.js";

export const saveFreshResponse = async (
  responses: FakeResponsesPort,
  input: {
    readonly responseId: string;
    readonly sessionId: string;
    readonly memberId: string;
    readonly choice: ResponseChoice;
    readonly sourceInteractionId: string;
    readonly now: Date;
  }
): Promise<
  | { readonly kind: "accepted"; readonly response: ResponseRow }
  | { readonly kind: "stale"; readonly response: ResponseRow }
> => {
  if (!/^\d{1,20}$/.test(input.sourceInteractionId)) {
    throw new Error("sourceInteractionId must be a numeric Discord snowflake");
  }
  const existing = responses.listAllResponses().find(
    (response) =>
      response.sessionId === input.sessionId &&
      response.memberId === input.memberId
  );
  if (
    existing?.sourceInteractionId &&
    BigInt(existing.sourceInteractionId) >= BigInt(input.sourceInteractionId)
  ) {
    return { kind: "stale", response: existing };
  }
  return {
    kind: "accepted",
    response: await responses.saveResponse({
      id: input.responseId,
      sessionId: input.sessionId,
      memberId: input.memberId,
      choice: input.choice,
      answeredAt: input.now,
      sourceInteractionId: input.sourceInteractionId
    })
  };
};

export const hasMember = async (
  members: MembersPort,
  memberId: string
): Promise<boolean> =>
  (await members.listMembers()).some((member) => member.id === memberId);

export const applyAskCancellation = async (
  sessions: FakeSessionsPort,
  current: SessionRow,
  requestedReason: AskCancellationReason,
  now: Date
): Promise<SessionRow> => {
  const reason: AskCancellationReason =
    current.postponeCount === 1
      ? "saturday_cancelled"
      : requestedReason === "absent"
        ? "absent"
        : "deadline_unanswered";
  const cancelled =
    current.status === "CANCELLED"
      ? current
      : await sessions.cancelAsking({ id: current.id, now, reason });
  if (!cancelled) {throw new Error("locked ask session disappeared");}

  const postponeDeadline = postponeDeadlineFor(
    parseCandidateDateIso(cancelled.candidateDateIso)
  );
  const startsPostponeVote =
    cancelled.postponeCount === 0 && now.getTime() < postponeDeadline.getTime();
  const projected = { ...cancelled, revision: cancelled.revision + 1 };
  const outbox = [
    buildSettleNoticeIntent(projected, reason, {
      forceSuppressMentions: startsPostponeVote,
      ordinal: 0
    }),
    ...(startsPostponeVote ? [buildPostponeVoteIntent(projected, 1)] : [])
  ];
  const settled = startsPostponeVote
    ? await sessions.startPostponeVoting({
        id: cancelled.id,
        now,
        postponeDeadlineAt: postponeDeadline,
        outbox
      })
    : await sessions.completeCancelledSession({ id: cancelled.id, now, outbox });
  if (!settled) {throw new Error("locked cancelled session disappeared");}
  return settled;
};

const createSaturday = async (
  sessions: FakeSessionsPort,
  parent: SessionRow,
  outbox: FakeOutboxPort,
  input: SubmitPostponeVoteInput["saturday"]
): Promise<SessionRow> => {
  const created = await sessions.createAskSession({
    id: input.id,
    weekKey: parent.weekKey,
    postponeCount: 1,
    candidateDateIso: input.candidateDateIso,
    channelId: parent.channelId,
    deadlineAt: input.deadlineAt,
    outbox: [
      buildAskBodyIntent({
        id: input.id,
        channelId: parent.channelId,
        revision: 0
      })
    ]
  });
  const persisted =
    created ??
    (await sessions.findSessionByWeekKeyAndPostponeCount(parent.weekKey, 1));
  if (!persisted) {throw new Error("Saturday session insert returned no row");}
  if (!created) { await outbox.enqueue(buildAskBodyIntent(persisted)); }
  return persisted;
};

export const applyPostponeDecision = async (
  sessions: FakeSessionsPort,
  current: SessionRow,
  outbox: FakeOutboxPort,
  decision: Exclude<PostponeDecisionResult, { kind: "pending" }>,
  input: Pick<SettlePostponeVotingInput, "now" | "saturday">
): Promise<
  | {
      readonly outcome: "all_ok";
      readonly session: SessionRow;
      readonly saturdaySession: SessionRow;
    }
  | { readonly outcome: "cancelled"; readonly session: SessionRow }
> => {
  if (decision.kind === "cancelled") {
    const completed = await sessions.completePostponeVoting({
      id: current.id,
      now: input.now,
      outcome: "cancelled_full",
      cancelReason: decision.reason
    });
    if (!completed) {throw new Error("locked postpone session disappeared");}
    return { outcome: "cancelled", session: completed };
  }

  const postponed = await sessions.completePostponeVoting({
    id: current.id,
    now: input.now,
    outcome: "decided"
  });
  if (!postponed) {throw new Error("locked postpone session disappeared");}
  return {
    outcome: "all_ok",
    session: postponed,
    saturdaySession: await createSaturday(sessions, current, outbox, input.saturday)
  };
};
