import type { EnqueueOutboxInput, SessionRow } from "../../src/db/ports.js";
import { makeSession } from "./fixtures.js";
import { MESSAGE_RECOVERY_STATUSES, recordCall } from "./ports.shared.js";
import type { FakeSessionsState } from "./ports.sessions.state.js";

interface EdgeInput {
  readonly id: string;
  readonly now: Date;
  readonly outbox?: readonly EnqueueOutboxInput[];
}

export interface FakeSessionTransitionMethods {
  cancelAsking(input: EdgeInput & {
    readonly reason: "absent" | "deadline_unanswered" | "saturday_cancelled";
  }): Promise<SessionRow | undefined>;
  startPostponeVoting(input: EdgeInput & {
    readonly postponeDeadlineAt: Date;
  }): Promise<SessionRow | undefined>;
  completePostponeVoting(input: EdgeInput & (
    | { readonly outcome: "decided" }
    | {
        readonly outcome: "cancelled_full";
        readonly cancelReason: "postpone_ng" | "postpone_unanswered";
      }
  )): Promise<SessionRow | undefined>;
  decideAsking(input: EdgeInput & {
    readonly decidedStartAt: Date;
    readonly reminderAt: Date;
  }): Promise<SessionRow | undefined>;
  completeCancelledSession(input: EdgeInput): Promise<SessionRow | undefined>;
  skipSession(input: {
    readonly id: string;
    readonly cancelReason: string;
  }): Promise<SessionRow | undefined>;
}

export const createFakeSessionTransitionMethods = (
  state: FakeSessionsState
): FakeSessionTransitionMethods => ({
  cancelAsking: async (input) => {
    recordCall(state.calls, "cancelAsking", { input });
    const found = state.byId.get(input.id);
    if (!found || found.status !== "ASKING") {return undefined;}
    const next = makeSession({
      ...found,
      status: "CANCELLED",
      cancelReason: input.reason,
      revision: found.revision + 1,
      updatedAt: input.now
    });
    state.byId.set(next.id, next);
    state.enqueueOutbox(input.outbox);
    return state.clone(next);
  },

  startPostponeVoting: async (input) => {
    recordCall(state.calls, "startPostponeVoting", { input });
    const found = state.byId.get(input.id);
    if (!found || found.status !== "CANCELLED") {return undefined;}
    const next = makeSession({
      ...found,
      status: "POSTPONE_VOTING",
      deadlineAt: input.postponeDeadlineAt,
      revision: found.revision + 1,
      updatedAt: input.now
    });
    state.byId.set(next.id, next);
    state.enqueueOutbox(input.outbox);
    return state.clone(next);
  },

  completePostponeVoting: async (input) => {
    recordCall(state.calls, "completePostponeVoting", { input });
    const found = state.byId.get(input.id);
    if (!found || found.status !== "POSTPONE_VOTING") {return undefined;}
    const next = makeSession({
      ...found,
      status: input.outcome === "decided" ? "POSTPONED" : "COMPLETED",
      cancelReason:
        input.outcome === "cancelled_full" ? input.cancelReason : found.cancelReason,
      revision: found.revision + 1,
      updatedAt: input.now
    });
    state.byId.set(next.id, next);
    state.enqueueOutbox(input.outbox);
    return state.clone(next);
  },

  decideAsking: async (input) => {
    recordCall(state.calls, "decideAsking", { input });
    const found = state.byId.get(input.id);
    if (!found || found.status !== "ASKING") {return undefined;}
    const next = makeSession({
      ...found,
      status: "DECIDED",
      decidedStartAt: input.decidedStartAt,
      reminderAt: input.reminderAt,
      revision: found.revision + 1,
      updatedAt: input.now
    });
    state.byId.set(next.id, next);
    state.enqueueOutbox(input.outbox);
    return state.clone(next);
  },

  completeCancelledSession: async (input) => {
    recordCall(state.calls, "completeCancelledSession", { input });
    const found = state.byId.get(input.id);
    if (!found || found.status !== "CANCELLED") {return undefined;}
    const next = makeSession({
      ...found,
      status: "COMPLETED",
      revision: found.revision + 1,
      updatedAt: input.now
    });
    state.byId.set(next.id, next);
    state.enqueueOutbox(input.outbox);
    return state.clone(next);
  },

  skipSession: async (input) => {
    recordCall(state.calls, "skipSession", { input });
    const found = state.byId.get(input.id);
    if (!found || !MESSAGE_RECOVERY_STATUSES.includes(found.status)) {return undefined;}
    const next = makeSession({
      ...found,
      status: "SKIPPED",
      cancelReason: input.cancelReason,
      revision: found.revision + 1,
      updatedAt: state.clock.now()
    });
    state.byId.set(next.id, next);
    return state.clone(next);
  }
});
