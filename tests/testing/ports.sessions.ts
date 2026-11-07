import type {
  EnqueueOutboxInput,
  SessionRow,
  SessionsPort
} from "../../src/db/ports.js";
import { checkpointMap } from "./transactions.ts";
import type { AnyCall, FakeClock } from "./ports.shared.js";
import { createFakeSessionMessageMethods } from "./ports.sessions.messages.js";
import { createFakeSessionQueryMethods } from "./ports.sessions.queries.js";
import { createFakeSessionsState } from "./ports.sessions.state.js";
import {
  createFakeSessionTransitionMethods,
  type FakeSessionTransitionMethods
} from "./ports.sessions.transitions.js";

export interface FakeWeeklySchedule {
  readonly weekKey: string;
  readonly autoSessionId: string | null;
  readonly disabledAt: Date | null;
}

export interface FakeSessionsPort extends SessionsPort, FakeSessionTransitionMethods {
  readonly calls: ReadonlyArray<AnyCall>;
  readonly weeklySchedules: Map<string, FakeWeeklySchedule>;
  listSessions(): ReadonlyArray<SessionRow>;
  bumpRevision(id: string, now: Date): SessionRow | undefined;
  completeDecidedForHeld(id: string, now: Date): SessionRow | undefined;
  checkpoint(): () => void;
}

/** In-memory SessionsPort with production-like CAS and uniqueness semantics. */
export const createFakeSessionsPort = (
  seed: ReadonlyArray<SessionRow>,
  clock: FakeClock,
  outboxEnqueue: (entry: EnqueueOutboxInput) => Promise<void>
): FakeSessionsPort => {
  const state = createFakeSessionsState(seed, clock, outboxEnqueue);
  const weeklySchedules = new Map<string, FakeWeeklySchedule>();
  for (const session of seed) {
    if (session.source === "weekly_auto") {
      weeklySchedules.set(session.weekKey, { weekKey: session.weekKey, autoSessionId: session.id, disabledAt: null });
    }
  }
  return {
    calls: state.calls,
    weeklySchedules,
    listSessions: () => Array.from(state.byId.values()).map(state.clone),
    checkpoint: () => {
      const undoSessions = checkpointMap(state.byId);
      const undoWeeks = checkpointMap(weeklySchedules);
      return () => { undoSessions(); undoWeeks(); };
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
