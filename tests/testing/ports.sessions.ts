import type {
  EnqueueOutboxInput,
  SessionRow,
  SessionsPort
} from "../../src/db/ports.js";
import { DEFAULT_CLOCK, type AnyCall, type FakeClock } from "./ports.shared.js";
import { createFakeSessionMessageMethods } from "./ports.sessions.messages.js";
import { createFakeSessionQueryMethods } from "./ports.sessions.queries.js";
import { createFakeSessionsState } from "./ports.sessions.state.js";
import { createFakeSessionTransitionMethods } from "./ports.sessions.transitions.js";

export interface FakeSessionsPort extends SessionsPort {
  readonly calls: ReadonlyArray<AnyCall>;
  listSessions(): ReadonlyArray<SessionRow>;
}

/** In-memory SessionsPort with production-like CAS and uniqueness semantics. */
export const createFakeSessionsPort = (
  seed: ReadonlyArray<SessionRow> = [],
  clock: FakeClock = DEFAULT_CLOCK,
  outboxEnqueue?: (entry: EnqueueOutboxInput) => void
): FakeSessionsPort => {
  const state = createFakeSessionsState(seed, clock, outboxEnqueue);
  return {
    calls: state.calls,
    listSessions: () => Array.from(state.byId.values()).map(state.clone),
    ...createFakeSessionMessageMethods(state),
    ...createFakeSessionTransitionMethods(state),
    ...createFakeSessionQueryMethods(state)
  };
};
