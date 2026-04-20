import type {
  DiscordPort,
  MemberRecord,
  MembersPort,
  ResponseRecord,
  ResponsesPort,
  SessionRecord,
  SessionStatus,
  SessionsPort,
  TransitionInput,
  UpsertResponseInput
} from "../../src/ports/index.js";

import {
  makeMember,
  makeResponse,
  makeSession
} from "./fixtures.js";

const NON_TERMINAL_STATUSES: readonly SessionStatus[] = [
  "ASKING",
  "POSTPONE_VOTING",
  "POSTPONED",
  "DECIDED",
  "CANCELLED"
];

type CallRecord<TName extends string, TArgs> = {
  readonly name: TName;
  readonly args: TArgs;
};

const recordCall = <TName extends string, TArgs>(
  target: Array<CallRecord<string, unknown>>,
  name: TName,
  args: TArgs
): void => {
  target.push({ name, args });
};

export interface FakeSessionsPort extends SessionsPort<unknown, SessionRecord> {
  readonly calls: ReadonlyArray<CallRecord<string, unknown>>;
  listSessions(): ReadonlyArray<SessionRecord>;
}

export interface FakeResponsesPort extends ResponsesPort<unknown, ResponseRecord> {
  readonly calls: ReadonlyArray<CallRecord<string, unknown>>;
  listAllResponses(): ReadonlyArray<ResponseRecord>;
}

export interface FakeMembersPort extends MembersPort<unknown, MemberRecord> {
  readonly calls: ReadonlyArray<CallRecord<string, unknown>>;
}

export interface DiscordCallMap {
  readonly sendMessage: ReadonlyArray<{ channelId: string; payload: Readonly<Record<string, unknown>> }>;
  readonly editMessage: ReadonlyArray<{
    channelId: string;
    messageId: string;
    payload: Readonly<Record<string, unknown>>;
  }>;
  readonly replyEphemeral: ReadonlyArray<{
    interactionId: string;
    payload: Readonly<Record<string, unknown>>;
  }>;
  readonly deferUpdate: ReadonlyArray<{ interactionId: string }>;
}

export interface FakeDiscordPort extends DiscordPort {
  readonly calls: DiscordCallMap;
}

// why: DI 可能な port interface の in-memory 実装。純粋・決定論的。
// invariant: 呼び出し順と引数を記録し、テストから assert 可能にする。
/**
 * Creates an in-memory fake for `SessionsPort`.
 *
 * @remarks
 * Emulates CAS semantics by returning `undefined` when `transitionStatus` loses the expected `from` match.
 * @see docs/adr/0014-naming-dictionary-v2.md
 * @see docs/adr/0015-error-core-apperror-neverthrow.md
 */
export const createFakeSessionsPort = (
  seed: ReadonlyArray<SessionRecord> = []
): FakeSessionsPort => {
  const calls: Array<CallRecord<string, unknown>> = [];
  const sessions = new Map(
    seed.map((session) => [
      session.id,
      makeSession(session)
    ])
  );

  return {
    calls,
    listSessions: () => Array.from(sessions.values()).map((session) => makeSession(session)),
    createAskSession: async (_db, input) => {
      recordCall(calls, "createAskSession", { input });
      const exists = Array.from(sessions.values()).find(
        (session) =>
          session.weekKey === input.weekKey &&
          session.postponeCount === input.postponeCount
      );
      if (exists) {
        return undefined;
      }

      const created = makeSession({
        id: input.id,
        weekKey: input.weekKey,
        postponeCount: input.postponeCount,
        candidateDateIso: input.candidateDateIso,
        channelId: input.channelId,
        deadlineAt: input.deadlineAt,
        status: "ASKING",
        createdAt: new Date(input.deadlineAt),
        updatedAt: new Date(input.deadlineAt)
      });
      sessions.set(created.id, created);
      return makeSession(created);
    },
    findSessionByWeekKeyAndPostponeCount: async (_db, weekKey, postponeCount) => {
      recordCall(calls, "findSessionByWeekKeyAndPostponeCount", { weekKey, postponeCount });
      const found = Array.from(sessions.values()).find(
        (session) => session.weekKey === weekKey && session.postponeCount === postponeCount
      );
      return found ? makeSession(found) : undefined;
    },
    findSessionById: async (_db, id) => {
      recordCall(calls, "findSessionById", { id });
      const found = sessions.get(id);
      return found ? makeSession(found) : undefined;
    },
    updateAskMessageId: async (_db, id, messageId) => {
      recordCall(calls, "updateAskMessageId", { id, messageId });
      const found = sessions.get(id);
      if (!found) {
        return;
      }
      sessions.set(id, makeSession({ ...found, askMessageId: messageId, updatedAt: new Date() }));
    },
    updatePostponeMessageId: async (_db, id, messageId) => {
      recordCall(calls, "updatePostponeMessageId", { id, messageId });
      const found = sessions.get(id);
      if (!found) {
        return;
      }
      sessions.set(id, makeSession({ ...found, postponeMessageId: messageId, updatedAt: new Date() }));
    },
    transitionStatus: async (_db, input: TransitionInput) => {
      recordCall(calls, "transitionStatus", { input });
      const found = sessions.get(input.id);
      if (!found || found.status !== input.from) {
        return undefined;
      }

      const next = makeSession({
        ...found,
        status: input.to,
        updatedAt: new Date(),
        cancelReason: input.cancelReason ?? found.cancelReason,
        decidedStartAt: input.decidedStartAt ?? found.decidedStartAt,
        reminderAt: input.reminderAt ?? found.reminderAt
      });
      sessions.set(next.id, next);
      return makeSession(next);
    },
    findDueAskingSessions: async (_db, now) => {
      recordCall(calls, "findDueAskingSessions", { now });
      return Array.from(sessions.values())
        .filter((session) => session.status === "ASKING" && session.deadlineAt <= now)
        .map((session) => makeSession(session));
    },
    findNonTerminalSessions: async (_db) => {
      recordCall(calls, "findNonTerminalSessions", {});
      return Array.from(sessions.values())
        .filter((session) => NON_TERMINAL_STATUSES.includes(session.status))
        .map((session) => makeSession(session));
    },
    isNonTerminal: (status) => NON_TERMINAL_STATUSES.includes(status)
  };
};

// why: DI 可能な port interface の in-memory 実装。純粋・決定論的。
// invariant: 呼び出し順と引数を記録し、テストから assert 可能にする。
/**
 * Creates an in-memory fake for `ResponsesPort`.
 *
 * @remarks
 * Maintains the `(sessionId, memberId)` uniqueness by upserting in-place.
 * @see docs/adr/0014-naming-dictionary-v2.md
 * @see docs/adr/0015-error-core-apperror-neverthrow.md
 */
export const createFakeResponsesPort = (
  seed: ReadonlyArray<ResponseRecord> = []
): FakeResponsesPort => {
  const calls: Array<CallRecord<string, unknown>> = [];
  const responses = seed.map((response) => makeResponse(response));

  return {
    calls,
    listAllResponses: () => responses.map((response) => makeResponse(response)),
    listResponses: async (_db, sessionId) => {
      recordCall(calls, "listResponses", { sessionId });
      return responses
        .filter((response) => response.sessionId === sessionId)
        .map((response) => makeResponse(response));
    },
    upsertResponse: async (_db, input: UpsertResponseInput) => {
      recordCall(calls, "upsertResponse", { input });
      const index = responses.findIndex(
        (response) =>
          response.sessionId === input.sessionId &&
          response.memberId === input.memberId
      );

      if (index === -1) {
        const created = makeResponse(input);
        responses.push(created);
        return makeResponse(created);
      }

      const current = responses[index];
      const next = makeResponse({
        ...current,
        choice: input.choice,
        answeredAt: input.answeredAt
      });
      responses[index] = next;
      return makeResponse(next);
    }
  };
};

// why: DI 可能な port interface の in-memory 実装。純粋・決定論的。
// invariant: 呼び出し順と引数を記録し、テストから assert 可能にする。
/**
 * Creates an in-memory fake for `MembersPort`.
 *
 * @remarks
 * Keeps member ordering stable for deterministic assertions.
 * @see docs/adr/0014-naming-dictionary-v2.md
 * @see docs/adr/0015-error-core-apperror-neverthrow.md
 */
export const createFakeMembersPort = (
  seed: ReadonlyArray<MemberRecord> = []
): FakeMembersPort => {
  const calls: Array<CallRecord<string, unknown>> = [];
  const members = seed.map((member) => makeMember(member));

  return {
    calls,
    findMemberIdByUserId: async (_db, userId) => {
      recordCall(calls, "findMemberIdByUserId", { userId });
      return members.find((member) => member.userId === userId)?.id;
    },
    listMembers: async (_db) => {
      recordCall(calls, "listMembers", {});
      return members.map((member) => makeMember(member));
    }
  };
};

// why: DI 可能な port interface の in-memory 実装。純粋・決定論的。
// invariant: 呼び出し順と引数を記録し、テストから assert 可能にする。
/**
 * Creates an in-memory fake for `DiscordPort`.
 *
 * @remarks
 * Stores outbound payloads so tests can assert side-effects without Discord I/O.
 * @see docs/adr/0014-naming-dictionary-v2.md
 * @see docs/adr/0015-error-core-apperror-neverthrow.md
 */
export const createFakeDiscordPort = (
  options: { messageIds?: ReadonlyArray<string> } = {}
): FakeDiscordPort => {
  let nextId = 1;
  const queuedIds = [...(options.messageIds ?? [])];
  const calls: {
    sendMessage: Array<{ channelId: string; payload: Readonly<Record<string, unknown>> }>;
    editMessage: Array<{ channelId: string; messageId: string; payload: Readonly<Record<string, unknown>> }>;
    replyEphemeral: Array<{ interactionId: string; payload: Readonly<Record<string, unknown>> }>;
    deferUpdate: Array<{ interactionId: string }>;
  } = {
    sendMessage: [],
    editMessage: [],
    replyEphemeral: [],
    deferUpdate: []
  };

  return {
    calls,
    sendMessage: async (input) => {
      calls.sendMessage.push(input);
      const messageId = queuedIds.shift() ?? `fake-message-${nextId}`;
      nextId += 1;
      return { messageId };
    },
    editMessage: async (input) => {
      calls.editMessage.push(input);
    },
    replyEphemeral: async (input) => {
      calls.replyEphemeral.push(input);
    },
    deferUpdate: async (input) => {
      calls.deferUpdate.push(input);
    }
  };
};
