import type { SessionsPort } from "../../src/db/ports.js";
import { makeSession } from "./fixtures.js";
import { NON_TERMINAL_STATUSES, recordCall } from "./ports.shared.js";
import type { FakeSessionsState } from "./ports.sessions.state.js";

type SessionTransitionMethods = Pick<
  SessionsPort,
  | "cancelAsking"
  | "startPostponeVoting"
  | "completePostponeVoting"
  | "decideAsking"
  | "completeCancelledSession"
  | "completeSession"
  | "claimReminderDispatch"
  | "revertReminderClaim"
  | "skipSession"
>;

export const createFakeSessionTransitionMethods = (
  state: FakeSessionsState
): SessionTransitionMethods => ({
  cancelAsking: async (input) => {
    recordCall(state.calls, "cancelAsking", { input });
    const found = state.byId.get(input.id);
    if (!found || found.status !== "ASKING") {return undefined;}
    const next = makeSession({
      ...found,
      status: "CANCELLED",
      cancelReason: input.reason,
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
    const next = makeSession({ ...found, status: "COMPLETED", updatedAt: input.now });
    state.byId.set(next.id, next);
    state.enqueueOutbox(input.outbox);
    return state.clone(next);
  },

  completeSession: async (input) => {
    recordCall(state.calls, "completeSession", { input });
    const found = state.byId.get(input.id);
    if (!found || found.status !== "DECIDED") {return undefined;}
    const next = makeSession({
      ...found,
      status: "COMPLETED",
      reminderSentAt: input.reminderSentAt,
      updatedAt: input.now
    });
    state.byId.set(next.id, next);
    state.enqueueOutbox(input.outbox);
    return state.clone(next);
  },

  claimReminderDispatch: async (id, now) => {
    recordCall(state.calls, "claimReminderDispatch", { id, now });
    const found = state.byId.get(id);
    if (!found || found.status !== "DECIDED" || found.reminderSentAt !== null) {
      return undefined;
    }
    const next = makeSession({
      ...found,
      reminderSentAt: now,
      updatedAt: state.clock.now()
    });
    state.byId.set(next.id, next);
    return state.clone(next);
  },

  revertReminderClaim: async (id, claimedAt) => {
    recordCall(state.calls, "revertReminderClaim", { id, claimedAt });
    const found = state.byId.get(id);
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
      updatedAt: state.clock.now()
    });
    state.byId.set(next.id, next);
    return true;
  },

  skipSession: async (input) => {
    recordCall(state.calls, "skipSession", { input });
    const found = state.byId.get(input.id);
    if (!found || !NON_TERMINAL_STATUSES.includes(found.status)) {return undefined;}
    const next = makeSession({
      ...found,
      status: "SKIPPED",
      cancelReason: input.cancelReason,
      updatedAt: state.clock.now()
    });
    state.byId.set(next.id, next);
    return state.clone(next);
  }
});
