import type { SessionsPort } from "../../src/db/ports.js";
import { makeSession } from "./fixtures.js";
import { recordCall } from "./ports.shared.js";
import type { FakeSessionsState } from "./ports.sessions.state.js";

type SessionMessageMethods = Pick<
  SessionsPort,
  | "createAskSession"
  | "updateAskMessageId"
  | "updatePostponeMessageId"
  | "backfillAskMessageId"
  | "backfillPostponeMessageId"
>;

export const createFakeSessionMessageMethods = (
  state: FakeSessionsState
): SessionMessageMethods => ({
  createAskSession: async (input) => {
    recordCall(state.calls, "createAskSession", { input });
    const duplicate = Array.from(state.byId.values()).find(
      (session) =>
        session.weekKey === input.weekKey &&
        session.postponeCount === input.postponeCount
    );
    if (duplicate) {return undefined;}
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
    state.byId.set(created.id, created);
    state.enqueueOutbox(input.outbox);
    return state.clone(created);
  },

  updateAskMessageId: async (id, messageId) => {
    recordCall(state.calls, "updateAskMessageId", { id, messageId });
    const found = state.byId.get(id);
    if (!found) {return;}
    state.byId.set(id, makeSession({
      ...found,
      askMessageId: messageId,
      updatedAt: state.clock.now()
    }));
  },

  updatePostponeMessageId: async (id, messageId) => {
    recordCall(state.calls, "updatePostponeMessageId", { id, messageId });
    const found = state.byId.get(id);
    if (!found) {return;}
    state.byId.set(id, makeSession({
      ...found,
      postponeMessageId: messageId,
      updatedAt: state.clock.now()
    }));
  },

  backfillAskMessageId: async (id, messageId) => {
    recordCall(state.calls, "backfillAskMessageId", { id, messageId });
    const found = state.byId.get(id);
    if (!found || found.askMessageId !== null) {return false;}
    state.byId.set(id, makeSession({
      ...found,
      askMessageId: messageId,
      updatedAt: state.clock.now()
    }));
    return true;
  },

  backfillPostponeMessageId: async (id, messageId) => {
    recordCall(state.calls, "backfillPostponeMessageId", { id, messageId });
    const found = state.byId.get(id);
    if (!found || found.postponeMessageId !== null) {return false;}
    state.byId.set(id, makeSession({
      ...found,
      postponeMessageId: messageId,
      updatedAt: state.clock.now()
    }));
    return true;
  }
});
