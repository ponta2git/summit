import type {
  EnqueueOutboxInput,
  SessionRow,
  SessionsPort
} from "../../src/db/ports.js";
import { DEFAULT_CLOCK, type AnyCall, type FakeClock } from "./ports.shared.js";
import { createFakeSessionMessageMethods } from "./ports.sessions.messages.js";
import { createFakeSessionQueryMethods } from "./ports.sessions.queries.js";
import { createFakeSessionsState } from "./ports.sessions.state.js";
import {
  createFakeSessionTransitionMethods,
  type FakeSessionTransitionMethods
} from "./ports.sessions.transitions.js";

export interface FakeSessionsPort extends SessionsPort, FakeSessionTransitionMethods {
  readonly calls: ReadonlyArray<AnyCall>;
  listSessions(): ReadonlyArray<SessionRow>;
  bumpRevision(id: string, now: Date): SessionRow | undefined;
  completeDecidedForHeld(id: string, now: Date): SessionRow | undefined;
  restoreSessions(rows: readonly SessionRow[]): void;
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
    restoreSessions: (rows) => {
      state.byId.clear();
      for (const row of rows) {
        state.byId.set(row.id, state.clone(row));
      }
    },
    bumpRevision: (id, now) => {
      const found = state.byId.get(id);
      if (!found) {return undefined;}
      const next = state.clone({
        ...found,
        revision: found.revision + 1,
        updatedAt: now
      });
      state.byId.set(id, next);
      return state.clone(next);
    },
    completeDecidedForHeld: (id, now) => {
      const found = state.byId.get(id);
      if (!found || found.status !== "DECIDED") {return undefined;}
      const next = state.clone({
        ...found,
        status: "COMPLETED",
        reminderSentAt: now,
        revision: found.revision + 1,
        updatedAt: now
      });
      state.byId.set(id, next);
      return state.clone(next);
    },
    ...createFakeSessionMessageMethods(state),
    ...createFakeSessionTransitionMethods(state),
    ...createFakeSessionQueryMethods(state)
  };
};
