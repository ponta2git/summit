// why: AppPorts の in-memory 実装。production と同じ AppContext を組み立ててテストに注入する。
// invariant: 呼び出し順と引数を call log で記録し、assertion 可能にする。CAS / unique 制約などの
//   業務 invariant は real port と同じ semantics で模倣する。
// invariant: createTestAppContext から渡された clock を fake ports 内部の updatedAt/createdAt に
//   使い、`new Date()` 直呼びを排除する。これによりテスト時刻が決定論的になる (M9)。
// @see docs/adr/0018-port-wiring-and-factory-injection.md

import { randomUUID } from "node:crypto";

import type {
  AppPorts,
  CompleteDecidedSessionAsHeldInput,
  CompleteDecidedSessionAsHeldResult,
  CompletePostponeVotingInput,
  CompleteSessionInput,
  CreateAskSessionInput,
  DecideAskingInput,
  EnqueueOutboxInput,
  EnqueueResult,
  HeldEventParticipantRow,
  HeldEventRow,
  HeldEventsPort,
  MemberRow,
  MembersPort,
  OutboxEntry,
  OutboxPort,
  ResponseRow,
  ResponsesPort,
  SessionRow,
  SessionStatus,
  SessionsPort,
  StartPostponeVotingInput,
  CancelAskingInput,
  CompleteCancelledSessionInput,
  UpsertResponseInput
} from "../../src/db/ports.js";

import { makeMember, makeResponse, makeSession } from "./fixtures.js";

type FakeClock = { readonly now: () => Date };
const DEFAULT_CLOCK: FakeClock = { now: () => new Date() };

const NON_TERMINAL_STATUSES: readonly SessionStatus[] = [
  "ASKING",
  "POSTPONE_VOTING",
  "POSTPONED",
  "DECIDED"
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

export interface FakeOutboxPort extends OutboxPort {
  readonly calls: ReadonlyArray<AnyCall>;
  listEntries(): ReadonlyArray<OutboxEntry>;
  /** Directly insert a test fixture (bypass CAS / dedupe checks). */
  seedEntry(entry: OutboxEntry): void;
}

export interface FakePorts extends AppPorts {
  readonly sessions: FakeSessionsPort;
  readonly responses: FakeResponsesPort;
  readonly members: FakeMembersPort;
  readonly heldEvents: FakeHeldEventsPort;
  readonly outbox: FakeOutboxPort;
}

/**
 * Create an in-memory fake for {@link SessionsPort}.
 *
 * @remarks
 * CAS semantics (`undefined` on race loss) and the
 * `(weekKey, postponeCount)` uniqueness are modelled faithfully.
 * `outboxEnqueue` が渡された場合、CAS 成功時に入力の `outbox` 配列を逐次 enqueue する
 * (production の `runEdgeUpdate` が tx 内で行う動作を模倣)。
 */
export const createFakeSessionsPort = (
  seed: ReadonlyArray<SessionRow> = [],
  clock: FakeClock = DEFAULT_CLOCK,
  outboxEnqueue?: (entry: EnqueueOutboxInput) => void
): FakeSessionsPort => {
  const calls: AnyCall[] = [];
  const byId = new Map<string, SessionRow>(
    seed.map((session) => [session.id, makeSession(session)])
  );

  const clone = (session: SessionRow): SessionRow => makeSession(session);

  // tx: CAS 成功時に outbox を enqueue する。production の runEdgeUpdate と同じ意味論。
  const enqueueOutbox = (entries: readonly EnqueueOutboxInput[] | undefined): void => {
    if (!entries || entries.length === 0 || !outboxEnqueue) {return;}
    for (const entry of entries) {
      outboxEnqueue(entry);
    }
  };

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
      byId.set(id, makeSession({ ...found, askMessageId: messageId, updatedAt: clock.now() }));
    },

    updatePostponeMessageId: async (id, messageId) => {
      recordCall(calls, "updatePostponeMessageId", { id, messageId });
      const found = byId.get(id);
      if (!found) {
        return;
      }
      byId.set(id, makeSession({ ...found, postponeMessageId: messageId, updatedAt: clock.now() }));
    },

    backfillAskMessageId: async (id, messageId) => {
      // idempotent: CAS-on-NULL; 既に askMessageId が設定されていれば何もせず false を返す。
      recordCall(calls, "backfillAskMessageId", { id, messageId });
      const found = byId.get(id);
      if (!found || found.askMessageId !== null) {
        return false;
      }
      byId.set(id, makeSession({ ...found, askMessageId: messageId, updatedAt: clock.now() }));
      return true;
    },

    backfillPostponeMessageId: async (id, messageId) => {
      recordCall(calls, "backfillPostponeMessageId", { id, messageId });
      const found = byId.get(id);
      if (!found || found.postponeMessageId !== null) {
        return false;
      }
      byId.set(id, makeSession({ ...found, postponeMessageId: messageId, updatedAt: clock.now() }));
      return true;
    },

    cancelAsking: async (input: CancelAskingInput) => {
      recordCall(calls, "cancelAsking", { input });
      const found = byId.get(input.id);
      if (!found || found.status !== "ASKING") {
        return undefined;
      }
      const next = makeSession({
        ...found,
        status: "CANCELLED",
        cancelReason: input.reason,
        updatedAt: input.now
      });
      byId.set(next.id, next);
      enqueueOutbox(input.outbox);
      return clone(next);
    },

    startPostponeVoting: async (input: StartPostponeVotingInput) => {
      recordCall(calls, "startPostponeVoting", { input });
      const found = byId.get(input.id);
      if (!found || found.status !== "CANCELLED") {
        return undefined;
      }
      const next = makeSession({
        ...found,
        status: "POSTPONE_VOTING",
        deadlineAt: input.postponeDeadlineAt,
        updatedAt: input.now
      });
      byId.set(next.id, next);
      enqueueOutbox(input.outbox);
      return clone(next);
    },

    completePostponeVoting: async (input: CompletePostponeVotingInput) => {
      recordCall(calls, "completePostponeVoting", { input });
      const found = byId.get(input.id);
      if (!found || found.status !== "POSTPONE_VOTING") {
        return undefined;
      }
      const next = makeSession({
        ...found,
        status: input.outcome === "decided" ? "POSTPONED" : "COMPLETED",
        cancelReason:
          input.outcome === "cancelled_full" ? input.cancelReason : found.cancelReason,
        updatedAt: input.now
      });
      byId.set(next.id, next);
      enqueueOutbox(input.outbox);
      return clone(next);
    },

    decideAsking: async (input: DecideAskingInput) => {
      recordCall(calls, "decideAsking", { input });
      const found = byId.get(input.id);
      if (!found || found.status !== "ASKING") {
        return undefined;
      }
      const next = makeSession({
        ...found,
        status: "DECIDED",
        decidedStartAt: input.decidedStartAt,
        reminderAt: input.reminderAt,
        updatedAt: input.now
      });
      byId.set(next.id, next);
      enqueueOutbox(input.outbox);
      return clone(next);
    },

    completeCancelledSession: async (input: CompleteCancelledSessionInput) => {
      recordCall(calls, "completeCancelledSession", { input });
      const found = byId.get(input.id);
      if (!found || found.status !== "CANCELLED") {
        return undefined;
      }
      const next = makeSession({
        ...found,
        status: "COMPLETED",
        updatedAt: input.now
      });
      byId.set(next.id, next);
      enqueueOutbox(input.outbox);
      return clone(next);
    },

    completeSession: async (input: CompleteSessionInput) => {
      recordCall(calls, "completeSession", { input });
      const found = byId.get(input.id);
      if (!found || found.status !== "DECIDED") {
        return undefined;
      }
      const next = makeSession({
        ...found,
        status: "COMPLETED",
        reminderSentAt: input.reminderSentAt,
        updatedAt: input.now
      });
      byId.set(next.id, next);
      enqueueOutbox(input.outbox);
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
        updatedAt: clock.now()
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
        updatedAt: clock.now()
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

    findStrandedCancelledSessions: async () => {
      recordCall(calls, "findStrandedCancelledSessions", {});
      return Array.from(byId.values())
        .filter((s) => s.status === "CANCELLED")
        .map(clone);
    },

    findStaleReminderClaims: async (olderThan) => {
      recordCall(calls, "findStaleReminderClaims", { olderThan });
      return Array.from(byId.values())
        .filter(
          (s) =>
            s.status === "DECIDED" &&
            s.reminderSentAt !== null &&
            s.reminderSentAt.getTime() <= olderThan.getTime()
        )
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
        updatedAt: clock.now()
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
  } = {},
  clock: FakeClock = DEFAULT_CLOCK
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
      const transitioned = await sessionsPort.completeSession({
        id: input.sessionId,
        now: input.reminderSentAt,
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
          createdAt: clock.now()
        };
      if (!existing) {
        heldEvents.push(heldEvent);
      }
      const insertedParticipants: HeldEventParticipantRow[] = [];
      const now = clock.now();
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
  readonly outbox?: ReadonlyArray<OutboxEntry>;
}

/**
 * Create an in-memory fake for {@link OutboxPort}.
 *
 * @remarks
 * - `enqueue`: `uq_discord_outbox_dedupe_active` の partial unique (非 FAILED) を模倣する。
 *   同じ dedupeKey が PENDING / IN_FLIGHT / DELIVERED で既に存在すれば skipped=true を返し、
 *   FAILED のみが残っていれば再 enqueue を許可 (real DB と同じ semantics)。
 * - `claimNextBatch`: `status='PENDING' AND nextAttemptAt<=now` および expired IN_FLIGHT を候補に
 *   `IN_FLIGHT` へ遷移、`attemptCount` を +1、`claimExpiresAt=now+ttl` を立てる。
 * - `markDelivered`/`markFailed`: CAS (status=IN_FLIGHT) を要求する real repository と揃える。
 * - `releaseExpiredClaims`: claim_expires_at を過ぎた IN_FLIGHT を PENDING に戻す。
 */
export const createFakeOutboxPort = (
  seed: ReadonlyArray<OutboxEntry> = [],
  clock: FakeClock = DEFAULT_CLOCK
): FakeOutboxPort => {
  const calls: AnyCall[] = [];
  const byId = new Map<string, OutboxEntry>(seed.map((e) => [e.id, { ...e }]));
  const cloneEntry = (e: OutboxEntry): OutboxEntry => ({ ...e });

  const activeDedupeIds = (key: string): OutboxEntry | undefined =>
    Array.from(byId.values()).find(
      (e) => e.dedupeKey === key && e.status !== "FAILED"
    );

  const port: FakeOutboxPort = {
    calls,
    listEntries: () => Array.from(byId.values()).map(cloneEntry),
    seedEntry: (entry) => {
      byId.set(entry.id, { ...entry });
    },

    enqueue: async (input: EnqueueOutboxInput): Promise<EnqueueResult> => {
      recordCall(calls, "enqueue", { input });
      // unique: 非 FAILED な同 dedupe_key は 1 件のみ (partial unique index 模倣)。
      const existing = activeDedupeIds(input.dedupeKey);
      if (existing) {
        return { id: existing.id, skipped: true };
      }
      const id = randomUUID();
      const now = clock.now();
      const entry: OutboxEntry = {
        id,
        kind: input.kind,
        sessionId: input.sessionId,
        payload: input.payload,
        dedupeKey: input.dedupeKey,
        status: "PENDING",
        attemptCount: 0,
        lastError: null,
        claimExpiresAt: null,
        nextAttemptAt: now,
        deliveredAt: null,
        deliveredMessageId: null,
        createdAt: now,
        updatedAt: now
      };
      byId.set(id, entry);
      return { id, skipped: false };
    },

    claimNextBatch: async ({ limit, now, claimDurationMs }) => {
      recordCall(calls, "claimNextBatch", { limit, now, claimDurationMs });
      // race: PENDING で next_attempt_at<=now もしくは expired IN_FLIGHT を候補にし、limit 件まで claim。
      const candidates = Array.from(byId.values())
        .filter((e) => {
          if (e.status === "PENDING" && e.nextAttemptAt <= now) {return true;}
          if (
            e.status === "IN_FLIGHT" &&
            e.claimExpiresAt !== null &&
            e.claimExpiresAt <= now
          ) {
            return true;
          }
          return false;
        })
        .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime())
        .slice(0, limit);
      const claimed: OutboxEntry[] = [];
      for (const c of candidates) {
        const next: OutboxEntry = {
          ...c,
          status: "IN_FLIGHT",
          attemptCount: c.attemptCount + 1,
          claimExpiresAt: new Date(now.getTime() + claimDurationMs),
          updatedAt: now
        };
        byId.set(c.id, next);
        claimed.push(cloneEntry(next));
      }
      return claimed;
    },

    markDelivered: async (id, { deliveredMessageId, now }) => {
      recordCall(calls, "markDelivered", { id, deliveredMessageId, now });
      const found = byId.get(id);
      // race: CAS (IN_FLIGHT→DELIVERED) のみ成立する。他状態は no-op。
      if (!found || found.status !== "IN_FLIGHT") {return false;}
      byId.set(id, {
        ...found,
        status: "DELIVERED",
        deliveredAt: now,
        deliveredMessageId,
        claimExpiresAt: null,
        updatedAt: now
      });
      return true;
    },

    markFailed: async (id, { error, now, nextAttemptAt }) => {
      recordCall(calls, "markFailed", { id, error, now, nextAttemptAt });
      const found = byId.get(id);
      if (!found || found.status !== "IN_FLIGHT") {return false;}
      byId.set(id, {
        ...found,
        status: nextAttemptAt === null ? "FAILED" : "PENDING",
        lastError: error.slice(0, 4000),
        claimExpiresAt: null,
        nextAttemptAt: nextAttemptAt ?? now,
        updatedAt: now
      });
      return true;
    },

    releaseExpiredClaims: async (now) => {
      recordCall(calls, "releaseExpiredClaims", { now });
      let released = 0;
      for (const e of Array.from(byId.values())) {
        if (
          e.status === "IN_FLIGHT" &&
          e.claimExpiresAt !== null &&
          e.claimExpiresAt <= now
        ) {
          byId.set(e.id, {
            ...e,
            status: "PENDING",
            claimExpiresAt: null,
            nextAttemptAt: now,
            updatedAt: now
          });
          released += 1;
        }
      }
      return released;
    },

    findStranded: async (threshold) => {
      recordCall(calls, "findStranded", { threshold });
      return Array.from(byId.values())
        .filter(
          (e) =>
            e.status === "FAILED" ||
            ((e.status === "PENDING" || e.status === "IN_FLIGHT") &&
              e.attemptCount >= threshold)
        )
        .map(cloneEntry);
    }
  };
  return port;
};

/**
 * Build a complete {@link FakePorts} bundle. Tests should prefer this over partial construction,
 * so that AppContext wiring parallels production.
 */
export const createFakePorts = (
  seed: FakePortsSeed = {},
  clock: FakeClock = DEFAULT_CLOCK
): FakePorts => {
  const outbox = createFakeOutboxPort(seed.outbox ?? [], clock);
  // tx: outbox enqueue callback を sessions fake に渡すことで、
  //   production の runEdgeUpdate (CAS と同 tx insert) を fake でも再現する。
  const sessions = createFakeSessionsPort(
    seed.sessions ?? [],
    clock,
    (entry: EnqueueOutboxInput) => {
      // why: fake 側は partial unique を onConflictDoNothing 相当に模倣する。
      //   非同期 API だが CAS 内部呼び出しなので sync に expose しておき await は不要。
      void outbox.enqueue(entry);
    }
  );
  const responses = createFakeResponsesPort(seed.responses ?? []);
  const members = createFakeMembersPort(seed.members ?? []);
  const heldEvents = createFakeHeldEventsPort(sessions, {
    heldEvents: seed.heldEvents ?? [],
    participants: seed.heldEventParticipants ?? []
  }, clock);
  return { sessions, responses, members, heldEvents, outbox };
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
    ports: options.ports ?? createFakePorts(options.seed ?? {}, clock),
    clock
  };
};
