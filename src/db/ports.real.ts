// source-of-truth: 契約は src/db/ports.ts、実装は src/db/repositories/*.ts。本ファイルは thin glue。
// @see ADR-0018

import type { DbLike } from "./rows.js";
import {
  cancelAsking,
  claimReminderDispatch,
  completeCancelledSession,
  completePostponeVoting,
  completeSession,
  createAskSession,
  decideAsking,
  findDueAskingSessions,
  findDuePostponeVotingSessions,
  findDueReminderSessions,
  findNonTerminalSessions,
  findNonTerminalSessionsByWeekKey,
  findSessionById,
  findSessionByWeekKeyAndPostponeCount,
  findStaleReminderClaims,
  findStrandedCancelledSessions,
  isNonTerminal,
  revertReminderClaim,
  skipSession,
  startPostponeVoting,
  updateAskMessageId,
  updatePostponeMessageId,
  backfillAskMessageId,
  backfillPostponeMessageId
} from "./repositories/sessions.js";
import {
  listResponses,
  upsertResponse
} from "./repositories/responses.js";
import {
  findMemberIdByUserId,
  listMembers
} from "./repositories/members.js";
import {
  completeDecidedSessionAsHeld,
  findHeldEventBySessionId,
  listHeldEventParticipants
} from "./repositories/heldEvents.js";
import {
  claimNextOutboxBatch,
  enqueueOutbox,
  findStrandedOutboxEntries,
  markOutboxDelivered,
  markOutboxFailed,
  releaseExpiredOutboxClaims
} from "./repositories/outbox.js";
import type {
  AppPorts,
  HeldEventsPort,
  MembersPort,
  OutboxPort,
  ResponsesPort,
  SessionsPort
} from "./ports.js";

const makeSessionsPort = (db: DbLike): SessionsPort => ({
  createAskSession: (input) => createAskSession(db, input),
  findSessionByWeekKeyAndPostponeCount: (weekKey, postponeCount) =>
    findSessionByWeekKeyAndPostponeCount(db, weekKey, postponeCount),
  findSessionById: (id) => findSessionById(db, id),
  updateAskMessageId: (id, messageId) => updateAskMessageId(db, id, messageId),
  updatePostponeMessageId: (id, messageId) => updatePostponeMessageId(db, id, messageId),
  backfillAskMessageId: (id, messageId) => backfillAskMessageId(db, id, messageId),
  backfillPostponeMessageId: (id, messageId) => backfillPostponeMessageId(db, id, messageId),
  cancelAsking: (input) => cancelAsking(db, input),
  startPostponeVoting: (input) => startPostponeVoting(db, input),
  completePostponeVoting: (input) => completePostponeVoting(db, input),
  decideAsking: (input) => decideAsking(db, input),
  completeCancelledSession: (input) => completeCancelledSession(db, input),
  completeSession: (input) => completeSession(db, input),
  claimReminderDispatch: (id, now) => claimReminderDispatch(db, id, now),
  revertReminderClaim: (id, claimedAt) => revertReminderClaim(db, id, claimedAt),
  findDueAskingSessions: (now) => findDueAskingSessions(db, now),
  findDuePostponeVotingSessions: (now) => findDuePostponeVotingSessions(db, now),
  findDueReminderSessions: (now) => findDueReminderSessions(db, now),
  findNonTerminalSessions: () => findNonTerminalSessions(db),
  findNonTerminalSessionsByWeekKey: (weekKey) =>
    findNonTerminalSessionsByWeekKey(db, weekKey),
  findStrandedCancelledSessions: () => findStrandedCancelledSessions(db),
  findStaleReminderClaims: (olderThan) => findStaleReminderClaims(db, olderThan),
  skipSession: (input) => skipSession(db, input),
  isNonTerminal
});

const makeResponsesPort = (db: DbLike): ResponsesPort => ({
  listResponses: (sessionId) => listResponses(db, sessionId),
  upsertResponse: (input) => upsertResponse(db, input)
});

const makeMembersPort = (db: DbLike): MembersPort => ({
  findMemberIdByUserId: (userId) => findMemberIdByUserId(db, userId),
  listMembers: () => listMembers(db)
});

const makeHeldEventsPort = (db: DbLike): HeldEventsPort => ({
  completeDecidedSessionAsHeld: (input) => completeDecidedSessionAsHeld(db, input),
  findBySessionId: (sessionId) => findHeldEventBySessionId(db, sessionId),
  listParticipants: (heldEventId) => listHeldEventParticipants(db, heldEventId)
});

const makeOutboxPort = (db: DbLike): OutboxPort => ({
  enqueue: (input) => enqueueOutbox(db, input),
  claimNextBatch: (options) => claimNextOutboxBatch(db, options),
  markDelivered: (id, options) => markOutboxDelivered(db, id, options),
  markFailed: (id, options) => markOutboxFailed(db, id, options),
  releaseExpiredClaims: (now) => releaseExpiredOutboxClaims(db, now),
  findStranded: (threshold) => findStrandedOutboxEntries(db, threshold)
});

export const makeRealPorts = (db: DbLike): AppPorts => ({
  sessions: makeSessionsPort(db),
  responses: makeResponsesPort(db),
  members: makeMembersPort(db),
  heldEvents: makeHeldEventsPort(db),
  outbox: makeOutboxPort(db)
});
