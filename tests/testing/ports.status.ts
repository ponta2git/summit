import type {
  CurrentWeekStatusSnapshot,
  SessionRow,
  StatusPort,
  StatusSessionSnapshot
} from "../../src/db/ports.js";
import { recordCall, type AnyCall } from "./ports.shared.js";
import type { FakeHeldEventsPort } from "./ports.heldEvents.js";
import type { FakeResponsesPort } from "./ports.responses.js";
import type { FakeSessionsPort } from "./ports.sessions.js";

const DETAIL_STATUSES = new Set<SessionRow["status"]>([
  "ASKING",
  "POSTPONE_VOTING",
  "DECIDED"
]);

/** In-memory implementation of the `/status` read model contract. */
export interface FakeStatusPort extends StatusPort {
  readonly calls: ReadonlyArray<AnyCall>;
}

export const createFakeStatusPort = (
  sessions: FakeSessionsPort,
  responses: FakeResponsesPort,
  heldEvents: FakeHeldEventsPort
): FakeStatusPort => {
  const calls: AnyCall[] = [];

  return {
    calls,
    loadCurrentWeekSnapshot: async (weekKey): Promise<CurrentWeekStatusSnapshot> => {
      recordCall(calls, "loadCurrentWeekSnapshot", { weekKey });
      const visible = sessions
        .listSessions()
        .filter(
          (session) =>
            session.weekKey === weekKey &&
            (DETAIL_STATUSES.has(session.status) || session.status === "CANCELLED")
        );
      const responseRows = responses.listAllResponses();
      const heldEventRows = heldEvents.listHeldEvents();
      const sessionDetails: StatusSessionSnapshot[] = visible
        .filter((session) => DETAIL_STATUSES.has(session.status))
        .map((session) => ({
          session,
          responses: responseRows.filter((response) => response.sessionId === session.id),
          heldEvent: session.status === "DECIDED"
            ? heldEventRows.find((event) => event.sessionId === session.id)
            : undefined
        }));

      return {
        sessions: sessionDetails,
        strandedCancelled: visible.filter((session) => session.status === "CANCELLED")
      };
    }
  };
};
