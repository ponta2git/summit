// why: AppPorts の in-memory 実装。production と同じ AppContext を組み立ててテストに注入する。
// invariant: 呼び出し順と引数を call log で記録し、assertion 可能にする。CAS / unique 制約などの
//   業務 invariant は real port と同じ semantics で模倣する。
// @see docs/adr/0018-port-wiring-and-factory-injection.md

import type {
  AppPorts,
  CompleteDecidedSessionAsHeldInput,
  CompleteDecidedSessionAsHeldResult,
  CreateAskSessionInput,
  HeldEventParticipantRow,
  HeldEventRow,
  HeldEventsPort,
  MemberRow,
  MembersPort,
  ResponseRow,
  ResponsesPort,
  SessionRow,
  SessionStatus,
  SessionsPort,
  TransitionInput,
  UpsertResponseInput
} from "../../src/db/ports.js";

import { makeMember, makeResponse, makeSession } from "./fixtures.js";

const NON_TERMINAL_STATUSES: readonly SessionStatus[] = [
  "ASKING",
  "POSTPONE_VOTING",
  "POSTPONED",
  "DECIDED",
  "CANCELLED"
];

type AnyCall = { readonly name: string; readonly args: unknown };

const recordCall = (target: AnyCall[], name: string, args: unknown): void => {
  target.push({ name, args });
};

export interface FakeSessionsPort extends SessionsPort {
  readonly calls: ReadonlyArray<AnyCall>;
  listSessions(): ReadonlyArray<SessionRow>;
}

export interface FakeResponsesPort extends ResponsesPort {
  readonly calls: ReadonlyArray<AnyCall>;
  listAllResponses(): ReadonlyArray<ResponseRow>;
}

export interface FakeMembersPort extends MembersPort {
  readonly calls: ReadonlyArray<AnyCall>;
}

export interface FakeHeldEventsPort extends HeldEventsPort {
  readonly calls: ReadonlyArray<AnyCall>;
  listHeldEvents(): ReadonlyArray<HeldEventRow>;
  listAllParticipants(): ReadonlyArray<HeldEventParticipantRow>;
}

export interface FakePorts extends AppPorts {
  readonly sessions: FakeSessionsPort;
  readonly responses: FakeResponsesPort;
  readonly members: FakeMembersPort;
  readonly heldEvents: FakeHeldEventsPort;
}

/**
 * Create an in-memory fake for {@link SessionsPort}.
 *
 * @remarks
 * CAS semantics (`transitionStatus` returns `undefined` when `from` mismatches) and the
 * `(weekKey, postponeCount)` uniqueness are modelled faithfully.
 */
export const createFakeSessionsPort = (
  seed: ReadonlyArray<SessionRow> = []
): FakeSessionsPort => {
  const calls: AnyCall[] = [];
  const byId = new Map<string, SessionRow>(
    seed.map((session) => [session.id, makeSession(session)])
  );

  const clone = (session: SessionRow): SessionRow => makeSession(session);

  return {
    calls,
    listSessions: () => Array.from(byId.values()).map(clone),
    createAskSession: async (input: CreateAskSessionInput) => {
      recordCall(calls, "createAskSession", { input });
      const dup = Array.from(byId.values()).find(
        (s) => s.weekKey === input.weekKey && s.postponeCount === input.postponeCount
      );
      if (dup) {
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
      byId.set(created.id, created);
      return clone(created);
    },
    findSessionByWeekKeyAndPostponeCount: async (weekKey, postponeCount) => {
      recordCall(calls, "findSessionByWeekKeyAndPostponeCount", { weekKey, postponeCount });
      const found = Array.from(byId.values()).find(
        (s) => s.weekKey === weekKey && s.postponeCount === postponeCount
      );
      return found ? clone(found) : undefined;
    },
    findSessionById: async (id) => {
      recordCall(calls, "findSessionById", { id });
      const found = byId.get(id);
      return found ? clone(found) : undefined;
    },
    updateAskMessageId: async (id, messageId) => {
      recordCall(calls, "updateAskMessageId", { id, messageId });
      const found = byId.get(id);
      if (!found) {
        return;
      }
      byId.set(id, makeSession({ ...found, askMessageId: messageId, updatedAt: new Date() }));
    },
    updatePostponeMessageId: async (id, messageId) => {
      recordCall(calls, "updatePostponeMessageId", { id, messageId });
      const found = byId.get(id);
      if (!found) {
        return;
      }
      byId.set(id, makeSession({ ...found, postponeMessageId: messageId, updatedAt: new Date() }));
    },
    transitionStatus: async (input: TransitionInput) => {
      recordCall(calls, "transitionStatus", { input });
      const found = byId.get(input.id);
      // race: CAS. WHERE status = from 相当の条件一致のみ遷移成功。
      if (!found || found.status !== input.from) {
        return undefined;
      }
      const next = makeSession({
        ...found,
        status: input.to,
        updatedAt: new Date(),
        cancelReason: input.cancelReason ?? found.cancelReason,
        decidedStartAt: input.decidedStartAt ?? found.decidedStartAt,
        reminderAt: input.reminderAt ?? found.reminderAt,
        reminderSentAt: input.reminderSentAt ?? found.reminderSentAt,
        deadlineAt: input.updatedDeadlineAt ?? found.deadlineAt
      });
      byId.set(next.id, next);
      return clone(next);
    },
    claimReminderDispatch: async (id, now) => {
      recordCall(calls, "claimReminderDispatch", { id, now });
      const found = byId.get(id);
      // race: `(status=DECIDED, reminder_sent_at IS NULL)` を両方満たすときのみ claim 成立。
      //   失敗時は undefined (他経路が先行)。
      if (!found || found.status !== "DECIDED" || found.reminderSentAt !== null) {
        return undefined;
      }
      const next = makeSession({
        ...found,
        reminderSentAt: now,
        updatedAt: new Date()
      });
      byId.set(next.id, next);
      return clone(next);
    },
    revertReminderClaim: async (id, claimedAt) => {
      recordCall(calls, "revertReminderClaim", { id, claimedAt });
      const found = byId.get(id);
      // race: claim と同じタイムスタンプで DECIDED のままの場合に限って NULL に戻す。
      if (
        !found ||
        found.status !== "DECIDED" ||
        found.reminderSentAt === null ||
        found.reminderSentAt.getTime() !== claimedAt.getTime()
      ) {
        return false;
      }
      const next = makeSession({
        ...found,
        reminderSentAt: null,
        updatedAt: new Date()
      });
      byId.set(next.id, next);
      return true;
    },
    findDueAskingSessions: async (now) => {
      recordCall(calls, "findDueAskingSessions", { now });
      return Array.from(byId.values())
        .filter((s) => s.status === "ASKING" && s.deadlineAt <= now)
        .map(clone);
    },
    findDuePostponeVotingSessions: async (now) => {
      recordCall(calls, "findDuePostponeVotingSessions", { now });
      return Array.from(byId.values())
        .filter((s) => s.status === "POSTPONE_VOTING" && s.deadlineAt <= now)
        .map(clone);
    },
    findDueReminderSessions: async (now) => {
      recordCall(calls, "findDueReminderSessions", { now });
      return Array.from(byId.values())
        .filter(
          (s) =>
            s.status === "DECIDED" &&
            s.reminderSentAt === null &&
            s.reminderAt !== null &&
            s.reminderAt <= now
        )
        .map(clone);
    },
    findNonTerminalSessions: async () => {
      recordCall(calls, "findNonTerminalSessions", {});
      return Array.from(byId.values())
        .filter((s) => NON_TERMINAL_STATUSES.includes(s.status))
        .map(clone);
    },
    findNonTerminalSessionsByWeekKey: async (weekKey) => {
      recordCall(calls, "findNonTerminalSessionsByWeekKey", { weekKey });
      return Array.from(byId.values())
        .filter((s) => s.weekKey === weekKey && NON_TERMINAL_STATUSES.includes(s.status))
        .map(clone);
    },
    skipSession: async (input) => {
      recordCall(calls, "skipSession", { input });
      const found = byId.get(input.id);
      // race: from を複数許容する CAS。既に terminal ならば undefined を返し、冪等に扱う。
      if (!found || !NON_TERMINAL_STATUSES.includes(found.status)) {
        return undefined;
      }
      const next = makeSession({
        ...found,
        status: "SKIPPED",
        cancelReason: input.cancelReason,
        updatedAt: new Date()
      });
      byId.set(next.id, next);
      return clone(next);
    },
    isNonTerminal: (status) => NON_TERMINAL_STATUSES.includes(status)
  };
};

/**
 * Create an in-memory fake for {@link ResponsesPort}.
 *
 * @remarks
 * `(sessionId, memberId)` unique 制約を in-place upsert で模倣する。
 */
export const createFakeResponsesPort = (
  seed: ReadonlyArray<ResponseRow> = []
): FakeResponsesPort => {
  const calls: AnyCall[] = [];
  const responses: ResponseRow[] = seed.map((r) => makeResponse(r));
  const clone = (r: ResponseRow): ResponseRow => makeResponse(r);

  return {
    calls,
    listAllResponses: () => responses.map(clone),
    listResponses: async (sessionId) => {
      recordCall(calls, "listResponses", { sessionId });
      return responses.filter((r) => r.sessionId === sessionId).map(clone);
    },
    upsertResponse: async (input: UpsertResponseInput) => {
      recordCall(calls, "upsertResponse", { input });
      const idx = responses.findIndex(
        (r) => r.sessionId === input.sessionId && r.memberId === input.memberId
      );
      if (idx === -1) {
        const created = makeResponse(input);
        responses.push(created);
        return clone(created);
      }
      const current = responses[idx] as ResponseRow;
      const next = makeResponse({
        ...current,
        choice: input.choice,
        answeredAt: input.answeredAt
      });
      responses[idx] = next;
      return clone(next);
    }
  };
};

/**
 * Create an in-memory fake for {@link MembersPort}.
 */
export const createFakeMembersPort = (
  seed: ReadonlyArray<MemberRow> = []
): FakeMembersPort => {
  const calls: AnyCall[] = [];
  const members = seed.map((m) => makeMember(m));

  return {
    calls,
    findMemberIdByUserId: async (userId) => {
      recordCall(calls, "findMemberIdByUserId", { userId });
      return members.find((m) => m.userId === userId)?.id;
    },
    listMembers: async () => {
      recordCall(calls, "listMembers", {});
      return members.map((m) => makeMember(m));
    }
  };
};

/**
 * Create an in-memory fake for {@link HeldEventsPort}.
 *
 * @remarks
 * `completeDecidedSessionAsHeld` は対象 sessions fake に委譲して DECIDED→COMPLETED CAS を
 * 模倣し、同期的に held_events / participants を内部配列に挿入する。本物と同じく CAS 敗北時は
 * held_events を書かずに undefined を返す（ロールバック相当）。
 */
export const createFakeHeldEventsPort = (
  sessionsPort: FakeSessionsPort,
  seed: {
    readonly heldEvents?: ReadonlyArray<HeldEventRow>;
    readonly participants?: ReadonlyArray<HeldEventParticipantRow>;
  } = {}
): FakeHeldEventsPort => {
  const calls: AnyCall[] = [];
  const heldEvents: HeldEventRow[] = (seed.heldEvents ?? []).map((h) => ({ ...h }));
  const participants: HeldEventParticipantRow[] = (seed.participants ?? []).map(
    (p) => ({ ...p })
  );
  let autoId = 0;
  const cloneHeld = (h: HeldEventRow): HeldEventRow => ({ ...h });
  const cloneParticipant = (
    p: HeldEventParticipantRow
  ): HeldEventParticipantRow => ({ ...p });

  return {
    calls,
    listHeldEvents: () => heldEvents.map(cloneHeld),
    listAllParticipants: () => participants.map(cloneParticipant),
    completeDecidedSessionAsHeld: async (
      input: CompleteDecidedSessionAsHeldInput
    ): Promise<CompleteDecidedSessionAsHeldResult | undefined> => {
      recordCall(calls, "completeDecidedSessionAsHeld", { input });
      // race: session の DECIDED→COMPLETED CAS を fake sessions 側で遂行する。
      //   敗北時は held_events を書かず undefined を返し、tx ロールバック相当を再現する。
      const transitioned = await sessionsPort.transitionStatus({
        id: input.sessionId,
        from: "DECIDED",
        to: "COMPLETED",
        reminderSentAt: input.reminderSentAt
      });
      if (!transitioned) {
        return undefined;
      }
      if (!transitioned.decidedStartAt) {
        // invariant: 本物の repository と同じく、DECIDED を抜けたら decidedStartAt を必ず持つ。
        throw new Error(
          `FakeHeldEventsPort: session ${transitioned.id} has no decidedStartAt despite DECIDED status`
        );
      }
      // idempotent: session_id unique 相当。既存 HeldEvent があれば使い回す。
      const existing = heldEvents.find((h) => h.sessionId === input.sessionId);
      const heldEvent: HeldEventRow =
        existing ??
        {
          id: `fake-held-${++autoId}`,
          sessionId: input.sessionId,
          heldDateIso: transitioned.candidateDateIso,
          startAt: new Date(transitioned.decidedStartAt),
          createdAt: new Date()
        };
      if (!existing) {
        heldEvents.push(heldEvent);
      }
      const insertedParticipants: HeldEventParticipantRow[] = [];
      const now = new Date();
      for (const memberId of input.memberIds) {
        const dup = participants.find(
          (p) => p.heldEventId === heldEvent.id && p.memberId === memberId
        );
        if (dup) {
          continue;
        }
        const row: HeldEventParticipantRow = {
          heldEventId: heldEvent.id,
          memberId,
          createdAt: now
        };
        participants.push(row);
        insertedParticipants.push(row);
      }
      return {
        session: transitioned,
        heldEvent: cloneHeld(heldEvent),
        participants: insertedParticipants.map(cloneParticipant)
      };
    },
    findBySessionId: async (sessionId) => {
      recordCall(calls, "findBySessionId", { sessionId });
      const found = heldEvents.find((h) => h.sessionId === sessionId);
      return found ? cloneHeld(found) : undefined;
    },
    listParticipants: async (heldEventId) => {
      recordCall(calls, "listParticipants", { heldEventId });
      return participants
        .filter((p) => p.heldEventId === heldEventId)
        .map(cloneParticipant);
    }
  };
};

export interface FakePortsSeed {
  readonly sessions?: ReadonlyArray<SessionRow>;
  readonly responses?: ReadonlyArray<ResponseRow>;
  readonly members?: ReadonlyArray<MemberRow>;
  readonly heldEvents?: ReadonlyArray<HeldEventRow>;
  readonly heldEventParticipants?: ReadonlyArray<HeldEventParticipantRow>;
}

/**
 * Build a complete {@link FakePorts} bundle. Tests should prefer this over partial construction,
 * so that AppContext wiring parallels production.
 */
export const createFakePorts = (seed: FakePortsSeed = {}): FakePorts => {
  const sessions = createFakeSessionsPort(seed.sessions ?? []);
  const responses = createFakeResponsesPort(seed.responses ?? []);
  const members = createFakeMembersPort(seed.members ?? []);
  const heldEvents = createFakeHeldEventsPort(sessions, {
    heldEvents: seed.heldEvents ?? [],
    participants: seed.heldEventParticipants ?? []
  });
  return { sessions, responses, members, heldEvents };
};

export interface TestAppContext {
  readonly ports: FakePorts;
  readonly clock: { readonly now: () => Date };
}

/**
 * Build an AppContext-shaped value for tests without depending on production's `createAppContext`.
 *
 * @remarks
 * Keeps the fake ports bundle typed as {@link FakePorts} so tests can inspect `calls` and seed
 * data while still passing structurally where an {@link import("../../src/appContext.js").AppContext}
 * is expected.
 */
export const createTestAppContext = (options: {
  readonly ports?: FakePorts;
  readonly now?: Date | (() => Date);
  readonly seed?: FakePortsSeed;
} = {}): TestAppContext => {
  const now = options.now ?? new Date();
  const clock = {
    now: typeof now === "function" ? now : () => now
  };
  return {
    ports: options.ports ?? createFakePorts(options.seed ?? {}),
    clock
  };
};
