import type { SessionsPort } from "../../src/db/ports.js";
import { NON_TERMINAL_STATUSES, recordCall } from "./ports.shared.js";
import type { FakeSessionsState } from "./ports.sessions.state.js";

type SessionQueryMethods = Pick<
  SessionsPort,
  | "findSessionByWeekKeyAndPostponeCount"
  | "findSessionById"
  | "findDueAskingSessions"
  | "findDuePostponeVotingSessions"
  | "findDueReminderSessions"
  | "getSchedulerSessionHints"
  | "findNonTerminalSessions"
  | "findStrandedCancelledSessions"
  | "findStaleReminderClaims"
  | "findNonTerminalSessionsByWeekKey"
  | "isNonTerminal"
>;

export const createFakeSessionQueryMethods = (
  state: FakeSessionsState
): SessionQueryMethods => ({
  findSessionByWeekKeyAndPostponeCount: async (weekKey, postponeCount) => {
    recordCall(state.calls, "findSessionByWeekKeyAndPostponeCount", {
      weekKey,
      postponeCount
    });
    const found = Array.from(state.byId.values()).find(
      (session) =>
        session.weekKey === weekKey && session.postponeCount === postponeCount
    );
    return found ? state.clone(found) : undefined;
  },

  findSessionById: async (id) => {
    recordCall(state.calls, "findSessionById", { id });
    const found = state.byId.get(id);
    return found ? state.clone(found) : undefined;
  },

  findDueAskingSessions: async (now) => {
    recordCall(state.calls, "findDueAskingSessions", { now });
    return Array.from(state.byId.values())
      .filter((session) => session.status === "ASKING" && session.deadlineAt <= now)
      .map(state.clone);
  },

  findDuePostponeVotingSessions: async (now) => {
    recordCall(state.calls, "findDuePostponeVotingSessions", { now });
    return Array.from(state.byId.values())
      .filter(
        (session) => session.status === "POSTPONE_VOTING" && session.deadlineAt <= now
      )
      .map(state.clone);
  },

  findDueReminderSessions: async (now) => {
    recordCall(state.calls, "findDueReminderSessions", { now });
    return Array.from(state.byId.values())
      .filter(
        (session) =>
          session.status === "DECIDED" &&
          session.reminderSentAt === null &&
          session.reminderAt !== null &&
          session.reminderAt <= now
      )
      .map(state.clone);
  },

  getSchedulerSessionHints: async (now) => {
    recordCall(state.calls, "getSchedulerSessionHints", { now });
    const minDate = (dates: Date[]): Date | null =>
      dates.length === 0
        ? null
        : dates.reduce((earliest, current) =>
          current.getTime() < earliest.getTime() ? current : earliest
        );
    const sessions = Array.from(state.byId.values());
    return {
      nextAskingDeadlineAt: minDate(
        sessions.filter((session) => session.status === "ASKING").map((session) => session.deadlineAt)
      ),
      nextPostponeDeadlineAt: minDate(
        sessions
          .filter((session) => session.status === "POSTPONE_VOTING")
          .map((session) => session.deadlineAt)
      ),
      nextReminderAt: minDate(
        sessions
          .filter(
            (session) =>
              session.status === "DECIDED" &&
              session.reminderSentAt === null &&
              session.reminderAt !== null
          )
          .map((session) => session.reminderAt as Date)
      )
    };
  },

  findNonTerminalSessions: async () => {
    recordCall(state.calls, "findNonTerminalSessions", {});
    return Array.from(state.byId.values())
      .filter((session) => NON_TERMINAL_STATUSES.includes(session.status))
      .map(state.clone);
  },

  findStrandedCancelledSessions: async () => {
    recordCall(state.calls, "findStrandedCancelledSessions", {});
    return Array.from(state.byId.values())
      .filter((session) => session.status === "CANCELLED")
      .map(state.clone);
  },

  findStaleReminderClaims: async (olderThan) => {
    recordCall(state.calls, "findStaleReminderClaims", { olderThan });
    return Array.from(state.byId.values())
      .filter(
        (session) =>
          session.status === "DECIDED" &&
          session.reminderSentAt !== null &&
          session.reminderSentAt.getTime() <= olderThan.getTime()
      )
      .map(state.clone);
  },

  findNonTerminalSessionsByWeekKey: async (weekKey) => {
    recordCall(state.calls, "findNonTerminalSessionsByWeekKey", { weekKey });
    return Array.from(state.byId.values())
      .filter(
        (session) =>
          session.weekKey === weekKey && NON_TERMINAL_STATUSES.includes(session.status)
      )
      .map(state.clone);
  },

  isNonTerminal: (status) => NON_TERMINAL_STATUSES.includes(status)
});
