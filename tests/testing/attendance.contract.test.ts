import { attendanceContract, attendanceMembers, attendanceNow, type AttendanceSeed, type AttendanceHarness } from "../contracts/attendance.ts";
import { createTestAppContext } from "./ports.ts";

attendanceContract("memory", async (seed: AttendanceSeed = {}): Promise<AttendanceHarness> => {
  const { ports } = createTestAppContext({ now: attendanceNow, seed: { ...seed, members: attendanceMembers } });
  return { ports,
    snapshot: async () => ({ sessions: ports.sessions.listSessions(), responses: ports.responses.listAllResponses(),
      outbox: ports.outbox.listEntries(), heldEvents: ports.heldEvents.listHeldEvents(), participants: ports.heldEvents.listAllParticipants() }),
    intents: async () => ports.outbox.listEntries().map(({ sessionId, dedupeKey, aggregateRevision, ordinal, payload }) =>
      ({ sessionId, dedupeKey, aggregateRevision, ordinal, payload }))
  };
});
