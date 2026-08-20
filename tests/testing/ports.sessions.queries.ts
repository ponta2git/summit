import type { SessionsPort } from "../../src/db/ports.js";
import { MESSAGE_RECOVERY_STATUSES, recordCall } from "./ports.shared.js";
import type { FakeSessionsState } from "./ports.sessions.state.js";

type SessionQueryMethods = Pick<
  SessionsPort,
  | "findSessionByWeekKeyAndPostponeCount"
  | "findSessionById"
  | "findDueAskingSessions"
  | "findDuePostponeVotingSessions"
  | "findDueReminderSessions"
  | "findDueStartupRecoverySessions"
  | "getSchedulerSessionHints"
  | "findMessageRecoveryCandidates"
  | "findStrandedCancelledSessions"
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
          session.reminderAt !== null &&
          session.reminderAt <= now
      )
      .map(state.clone);
  },

  findDueStartupRecoverySessions: async (now) => {
    recordCall(state.calls, "findDueStartupRecoverySessions", { now });
    return Array.from(state.byId.values())
      .filter(
        (session) =>
          ((session.status === "ASKING" || session.status === "POSTPONE_VOTING") &&
            session.deadlineAt <= now) ||
          (session.status === "DECIDED" &&
            session.reminderAt !== null &&
            session.reminderAt <= now)
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
              session.reminderAt !== null
          )
          .map((session) => session.reminderAt as Date)
      )
    };
  },

  findMessageRecoveryCandidates: async () => {
    recordCall(state.calls, "findMessageRecoveryCandidates", {});
    return Array.from(state.byId.values())
      .filter((session) => MESSAGE_RECOVERY_STATUSES.includes(session.status))
      .map(state.clone);
  },

  findStrandedCancelledSessions: async () => {
    recordCall(state.calls, "findStrandedCancelledSessions", {});
    return Array.from(state.byId.values())
      .filter((session) => session.status === "CANCELLED")
      .map(state.clone);
  }
});
