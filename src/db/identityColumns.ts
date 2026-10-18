import { heldEventParticipants, heldEvents, members, responses, sessions } from "./schema.ts";
import { wireId, wireReference, type IdentityLayout } from "./identities.ts";

// Explicit wire projections keep schema-only alias/public columns out of domain rows.
export const sessionColumns = (layout: IdentityLayout) => ({
  id: wireId(layout, sessions), weekKey: sessions.weekKey, postponeCount: sessions.postponeCount,
  candidateDateIso: sessions.candidateDateIso, status: sessions.status, channelId: sessions.channelId,
  askMessageId: sessions.askMessageId, postponeMessageId: sessions.postponeMessageId,
  deadlineAt: sessions.deadlineAt, decidedStartAt: sessions.decidedStartAt, cancelReason: sessions.cancelReason,
  reminderAt: sessions.reminderAt, reminderSentAt: sessions.reminderSentAt, revision: sessions.revision,
  createdAt: sessions.createdAt, updatedAt: sessions.updatedAt
});

export const responseColumns = (layout: IdentityLayout) => ({
  id: wireId(layout, responses), sessionId: wireReference(layout, sessions, responses.sessionId),
  memberId: wireReference(layout, members, responses.memberId), choice: responses.choice,
  answeredAt: responses.answeredAt, sourceInteractionId: responses.sourceInteractionId
});

export const heldEventColumns = (layout: IdentityLayout) => ({
  id: wireId(layout, heldEvents), sessionId: wireReference<string | null>(layout, sessions, heldEvents.sessionId),
  heldDateIso: heldEvents.heldDateIso, startAt: heldEvents.startAt, createdAt: heldEvents.createdAt
});

export const participantColumns = (layout: IdentityLayout) => ({
  heldEventId: wireReference(layout, heldEvents, heldEventParticipants.heldEventId),
  memberId: wireReference(layout, members, heldEventParticipants.memberId),
  createdAt: heldEventParticipants.createdAt
});
