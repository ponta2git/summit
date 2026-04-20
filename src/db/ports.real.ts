// why: repository を束ねて AppPorts を構成する production 実装。db ハンドルを closure で保持する。
// invariant: 契約は src/db/ports.ts、実装は src/db/repositories/*.ts。本ファイルは thin glue に徹する。
// @see docs/adr/0018-port-wiring-and-factory-injection.md

import type { DbLike } from "./types.js";
import {
  createAskSession,
  findDueAskingSessions,
  findDuePostponeVotingSessions,
  findDueReminderSessions,
  findNonTerminalSessions,
  findNonTerminalSessionsByWeekKey,
  findSessionById,
  findSessionByWeekKeyAndPostponeCount,
  isNonTerminal,
  skipSession,
  transitionStatus,
  updateAskMessageId,
  updatePostponeMessageId
} from "./repositories/sessions.js";
import {
  listResponses,
  upsertResponse
} from "./repositories/responses.js";
import {
  findMemberIdByUserId,
  listMembers
} from "./repositories/members.js";
import type { AppPorts, MembersPort, ResponsesPort, SessionsPort } from "./ports.js";

const makeSessionsPort = (db: DbLike): SessionsPort => ({
  createAskSession: (input) => createAskSession(db, input),
  findSessionByWeekKeyAndPostponeCount: (weekKey, postponeCount) =>
    findSessionByWeekKeyAndPostponeCount(db, weekKey, postponeCount),
  findSessionById: (id) => findSessionById(db, id),
  updateAskMessageId: (id, messageId) => updateAskMessageId(db, id, messageId),
  updatePostponeMessageId: (id, messageId) => updatePostponeMessageId(db, id, messageId),
  transitionStatus: (input) => transitionStatus(db, input),
  findDueAskingSessions: (now) => findDueAskingSessions(db, now),
  findDuePostponeVotingSessions: (now) => findDuePostponeVotingSessions(db, now),
  findDueReminderSessions: (now) => findDueReminderSessions(db, now),
  findNonTerminalSessions: () => findNonTerminalSessions(db),
  findNonTerminalSessionsByWeekKey: (weekKey) =>
    findNonTerminalSessionsByWeekKey(db, weekKey),
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

export const makeRealPorts = (db: DbLike): AppPorts => ({
  sessions: makeSessionsPort(db),
  responses: makeResponsesPort(db),
  members: makeMembersPort(db)
});
