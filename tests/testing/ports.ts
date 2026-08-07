// why: AppPorts の domain fake を組み合わせ、production と同じ AppContext shape を作る。
// @see docs/adr/0018-port-wiring-and-factory-injection.md

import type {
  AppPorts,
  EnqueueOutboxInput,
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
import { createFakeResponsesPort, type FakeResponsesPort } from "./ports.responses.js";
import { DEFAULT_CLOCK, type FakeClock } from "./ports.shared.js";
import { createFakeSessionsPort, type FakeSessionsPort } from "./ports.sessions.js";

export interface FakePorts extends AppPorts {
  readonly sessions: FakeSessionsPort;
  readonly responses: FakeResponsesPort;
  readonly members: FakeMembersPort;
  readonly heldEvents: FakeHeldEventsPort;
  readonly outbox: FakeOutboxPort;
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
    (entry: EnqueueOutboxInput) => {
      void outbox.enqueue(entry);
    }
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
  return { sessions, responses, members, heldEvents, outbox };
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
  const now = options.now ?? new Date();
  const clock = { now: typeof now === "function" ? now : () => now };
  return {
    ports: options.ports ?? createFakePorts(options.seed ?? {}, clock),
    clock
  };
};

export {
  createFakeResponsesPort,
  createFakeSessionsPort
};
