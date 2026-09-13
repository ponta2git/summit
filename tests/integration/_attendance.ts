import { eq } from "drizzle-orm";
import { makeRealPorts } from "../../src/db/ports.real.ts";
import { sessions, responses, members, discordNotifications, discordNotificationAttendance, discordNotificationParts, heldEvents, heldEventParticipants } from "../../src/db/schema.ts";
import { attendanceMembers, type AttendanceHarness, type AttendanceSeed } from "../contracts/attendance.ts";
import { createIntegrationDb, truncatePerTestTables } from "./_support.ts";

export const createAttendanceHarness = () => {
  const { db, client } = createIntegrationDb({ maxConnections: 4 });
  const ports = makeRealPorts(db);
  const create = async (seed: AttendanceSeed = {}): Promise<AttendanceHarness> => {
    await truncatePerTestTables(db);
    for (const member of attendanceMembers) {
      await db.insert(members).values(member).onConflictDoUpdate({ target: members.id, set: member });
    }
    if (seed.sessions?.length) { await db.insert(sessions).values([...seed.sessions]); }
    if (seed.responses?.length) { await db.insert(responses).values([...seed.responses]); }
    return { ports,
      snapshot: async () => ({ sessions: await db.select().from(sessions).orderBy(sessions.id), responses: await db.select().from(responses).orderBy(responses.id),
        notifications: await db.select().from(discordNotifications).orderBy(discordNotifications.id),
        attendance: await db.select().from(discordNotificationAttendance).orderBy(discordNotificationAttendance.notificationId),
        parts: await db.select().from(discordNotificationParts).orderBy(discordNotificationParts.notificationId),
        heldEvents: await db.select().from(heldEvents).orderBy(heldEvents.id), participants: await db.select().from(heldEventParticipants).orderBy(heldEventParticipants.memberId) }),
      intents: async () => db.select({ sessionId: discordNotificationAttendance.sessionId, dedupeKey: discordNotifications.dedupeKey,
        aggregateRevision: discordNotificationAttendance.aggregateRevision, ordinal: discordNotificationAttendance.ordinal, payload: discordNotifications.payload })
        .from(discordNotifications).innerJoin(discordNotificationAttendance, eq(discordNotificationAttendance.notificationId, discordNotifications.id))
        .orderBy(discordNotificationAttendance.aggregateRevision, discordNotificationAttendance.ordinal)
    };
  };
  return { create, db, client };
};
