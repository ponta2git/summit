// source-of-truth: 契約は src/db/ports.ts、実装は src/db/repositories/*.ts。本ファイルは thin glue。
// @see docs/architecture.md

import type { DbLike } from "./rows.ts";
import {
  createAskSession,
  findDueAskingSessions,
  findDuePostponeVotingSessions,
  findDueReminderSessions,
  findDueStartupRecoverySessions,
  findMessageRecoveryCandidates,
  getSchedulerSessionHints,
  findSessionById,
  findSessionByWeekKeyAndPostponeCount,
  findStrandedCancelledSessions,
  updateAskMessageId,
  updatePostponeMessageId,
  backfillAskMessageId,
  backfillPostponeMessageId
} from "./repositories/sessions.ts";
import { loadCurrentWeekSnapshot } from "./repositories/status.ts";
import { listResponses } from "./repositories/responses.ts";
import {
  cancelWeekAtomically,
  settleAskingCancellation,
  settleAskingDeadline,
  settlePostponeVoting,
  submitAskResponse,
  submitPostponeVote
} from "./repositories/sessionCommands.ts";
import {
  findMemberIdByUserId,
  listMembers
} from "./repositories/members.ts";
import {
  completeDecidedSessionAsHeld,
  findHeldEventBySessionId
} from "./repositories/heldEvents.ts";
import {
  claimNextOutboxBatch,
  beginOutboxDelivery,
  enqueueOutbox,
  findStrandedOutboxEntries,
  getOutboxMetrics,
  getNextOutboxDispatchAt,
  markOutboxDelivered,
  markOutboxFailed,
  pruneOutbox,
  requeueFailedOutboxChains,
  releaseExpiredOutboxClaims
} from "./repositories/outbox.ts";
import type {
  AppPorts,
  HeldEventsPort,
  MembersPort,
  OutboxPort,
  ResponsesPort,
  SessionCommandsPort,
  SessionsPort,
  StatusPort
} from "./ports.ts";

const makeSessionsPort = (db: DbLike): SessionsPort => ({
  createAskSession: (input) => createAskSession(db, input),
  findSessionByWeekKeyAndPostponeCount: (weekKey, postponeCount) =>
    findSessionByWeekKeyAndPostponeCount(db, weekKey, postponeCount),
  findSessionById: (id) => findSessionById(db, id),
  updateAskMessageId: (id, messageId) => updateAskMessageId(db, id, messageId),
  updatePostponeMessageId: (id, messageId) => updatePostponeMessageId(db, id, messageId),
  backfillAskMessageId: (id, messageId) => backfillAskMessageId(db, id, messageId),
  backfillPostponeMessageId: (id, messageId) => backfillPostponeMessageId(db, id, messageId),
  findDueAskingSessions: (now) => findDueAskingSessions(db, now),
  findDuePostponeVotingSessions: (now) => findDuePostponeVotingSessions(db, now),
  findDueReminderSessions: (now) => findDueReminderSessions(db, now),
  findDueStartupRecoverySessions: (now) => findDueStartupRecoverySessions(db, now),
  getSchedulerSessionHints: (now) => getSchedulerSessionHints(db, now),
  findMessageRecoveryCandidates: () => findMessageRecoveryCandidates(db),
  findStrandedCancelledSessions: () => findStrandedCancelledSessions(db)
});

const makeResponsesPort = (db: DbLike): ResponsesPort => ({
  listResponses: (sessionId) => listResponses(db, sessionId)
});

const makeSessionCommandsPort = (db: DbLike): SessionCommandsPort => ({
  cancelWeekAtomically: (input) => cancelWeekAtomically(db, input),
  submitAskResponse: (input) => submitAskResponse(db, input),
  settleAskingCancellation: (input) => settleAskingCancellation(db, input),
  settleAskingDeadline: (input) => settleAskingDeadline(db, input),
  submitPostponeVote: (input) => submitPostponeVote(db, input),
  settlePostponeVoting: (input) => settlePostponeVoting(db, input)
});

const makeMembersPort = (db: DbLike): MembersPort => ({
  findMemberIdByUserId: (userId) => findMemberIdByUserId(db, userId),
  listMembers: () => listMembers(db)
});

const makeHeldEventsPort = (db: DbLike): HeldEventsPort => ({
  completeDecidedSessionAsHeld: (input) => completeDecidedSessionAsHeld(db, input),
  findBySessionId: (sessionId) => findHeldEventBySessionId(db, sessionId)
});

const makeStatusPort = (db: DbLike): StatusPort => ({
  loadCurrentWeekSnapshot: (weekKey) => loadCurrentWeekSnapshot(db, weekKey)
});

const makeOutboxPort = (db: DbLike): OutboxPort => ({
  enqueue: (input) => enqueueOutbox(db, input),
  claimNextBatch: (options) => claimNextOutboxBatch(db, options),
  beginDelivery: (id, options) => beginOutboxDelivery(db, id, options),
  markDelivered: (id, options) => markOutboxDelivered(db, id, options),
  markFailed: (id, options) => markOutboxFailed(db, id, options),
  requeueFailedChains: (now) => requeueFailedOutboxChains(db, now),
  releaseExpiredClaims: (now) => releaseExpiredOutboxClaims(db, now),
  findStranded: (threshold) => findStrandedOutboxEntries(db, threshold),
  prune: (options) => pruneOutbox(db, options),
  getMetrics: (now) => getOutboxMetrics(db, now),
  getNextDispatchAt: (now) => getNextOutboxDispatchAt(db, now)
});

export const makeRealPorts = (db: DbLike): AppPorts => ({
  sessions: makeSessionsPort(db),
  sessionCommands: makeSessionCommandsPort(db),
  responses: makeResponsesPort(db),
  members: makeMembersPort(db),
  heldEvents: makeHeldEventsPort(db),
  status: makeStatusPort(db),
  outbox: makeOutboxPort(db)
});
