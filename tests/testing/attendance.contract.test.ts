import { sessionCreationContract } from "../contracts/sessionCreation.ts";
import { attendanceContract, attendanceMembers, attendanceNow, type AttendanceSeed, type AttendanceHarness } from "../contracts/attendance.ts";
import { createTestAppContext } from "./ports.ts";

const create = async (seed: AttendanceSeed = {}): Promise<AttendanceHarness> => {
  const { ports } = createTestAppContext({ now: attendanceNow, seed: { ...seed, members: attendanceMembers } });
  return { ports,
    snapshot: async () => ({ weeks: structuredClone([...ports.sessions.weeklySchedules.values()]), sessions: ports.sessions.listSessions(), responses: ports.responses.listAllResponses(),
      outbox: ports.outbox.listEntries(), heldEvents: ports.heldEvents.listHeldEvents(), participants: ports.heldEvents.listAllParticipants() }),
    intents: async () => ports.outbox.listEntries().map(({ sessionId, dedupeKey, aggregateRevision, ordinal, payload }) =>
      ({ sessionId, dedupeKey, aggregateRevision, ordinal, payload }))
  };
};
attendanceContract("memory", create);
sessionCreationContract("memory", create);
