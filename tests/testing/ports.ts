// why: AppPorts の domain fake を組み合わせ、production と同じ AppContext shape を作る。
// @see docs/test-rule.md

import type {
  AppPorts,
  HeldEventParticipantRow,
  HeldEventRow,
  MemberRow,
  OutboxEntry,
  ResponseRow,
  SessionRow
} from "../../src/db/ports.js";
import {
  createFakeHeldEventsPort,
  type FakeHeldEventsPort
} from "./ports.heldEvents.js";
import { createFakeMembersPort, type FakeMembersPort } from "./ports.members.js";
import { createFakeOutboxPort, type FakeOutboxPort } from "./ports.outbox.js";
import { createFakeResultNotificationsPort, type FakeResultNotificationsPort } from "./ports.resultNotifications.ts";
import { createFakeResponsesPort, type FakeResponsesPort } from "./ports.responses.js";
import {
  createFakeSessionCommandsPort,
  type FakeSessionCommandsPort
} from "./ports.sessionCommands.js";
import { createFakeTransaction } from "./transactions.ts";
import { DEFAULT_CLOCK, type FakeClock } from "./ports.shared.js";
import { createFakeSessionsPort, type FakeSessionsPort } from "./ports.sessions.js";
import { createFakeStatusPort, type FakeStatusPort } from "./ports.status.js";

export interface FakePorts extends AppPorts {
  readonly sessions: FakeSessionsPort;
  readonly sessionCommands: FakeSessionCommandsPort;
  readonly responses: FakeResponsesPort;
  readonly members: FakeMembersPort;
  readonly heldEvents: FakeHeldEventsPort;
  readonly status: FakeStatusPort;
  readonly outbox: FakeOutboxPort;
  readonly resultNotifications: FakeResultNotificationsPort;
}

export interface FakePortsSeed {
  readonly sessions?: ReadonlyArray<SessionRow>;
  readonly responses?: ReadonlyArray<ResponseRow>;
  readonly members?: ReadonlyArray<MemberRow>;
  readonly heldEvents?: ReadonlyArray<HeldEventRow>;
  readonly heldEventParticipants?: ReadonlyArray<HeldEventParticipantRow>;
  readonly outbox?: ReadonlyArray<OutboxEntry>;
}

const createFakePorts = (
  seed: FakePortsSeed = {},
  clock: FakeClock = DEFAULT_CLOCK
): FakePorts => {
  const outbox = createFakeOutboxPort(seed.outbox ?? [], clock);
  const sessions = createFakeSessionsPort(
    seed.sessions ?? [],
    clock,
    async (entry) => { await outbox.enqueue(entry); }
  );
  const responses = createFakeResponsesPort(seed.responses ?? []);
  const members = createFakeMembersPort(seed.members ?? []);
  const heldEvents = createFakeHeldEventsPort(
    sessions,
    {
      heldEvents: seed.heldEvents ?? [],
      participants: seed.heldEventParticipants ?? []
    },
    clock
  );
  const sessionCommands = createFakeSessionCommandsPort(
    sessions,
    responses,
    members,
    heldEvents,
    outbox
  );
  const atomic = createFakeTransaction(() => {
    const rollbacks = [sessions.checkpoint(), responses.checkpoint(), heldEvents.checkpoint(), outbox.checkpoint()];
    return () => { for (const rollback of rollbacks) { rollback(); } };
  });
  sessions.createAskSession = atomic(sessions.createAskSession);
  heldEvents.completeDecidedSessionAsHeld = atomic(heldEvents.completeDecidedSessionAsHeld);
  sessionCommands.recoverMissingMessageIntents = atomic(sessionCommands.recoverMissingMessageIntents);
  sessionCommands.submitAskResponse = atomic(sessionCommands.submitAskResponse);
  sessionCommands.settleAskingCancellation = atomic(sessionCommands.settleAskingCancellation);
  sessionCommands.settleAskingDeadline = atomic(sessionCommands.settleAskingDeadline);
  sessionCommands.submitPostponeVote = atomic(sessionCommands.submitPostponeVote);
  sessionCommands.settlePostponeVoting = atomic(sessionCommands.settlePostponeVoting);
  sessionCommands.cancelWeekAtomically = atomic(sessionCommands.cancelWeekAtomically);
  const status = createFakeStatusPort(sessions, responses, heldEvents);
  return { sessions, sessionCommands, responses, members, heldEvents, status, outbox,
    resultNotifications: createFakeResultNotificationsPort(clock) };
};

export interface TestAppContext {
  readonly ports: FakePorts;
  readonly clock: { readonly now: () => Date };
}

export const createTestAppContext = (options: {
  readonly ports?: FakePorts;
  readonly now?: Date | (() => Date);
  readonly seed?: FakePortsSeed;
} = {}): TestAppContext => {
  const now = options.now ?? DEFAULT_CLOCK.now;
  const clock = { now: typeof now === "function" ? () => new Date(now()) : () => new Date(now) };
  return {
    ports: options.ports ?? createFakePorts(options.seed ?? {}, clock),
    clock
  };
};

export { createFakeSessionsPort };
