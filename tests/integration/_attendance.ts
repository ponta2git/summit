import { fixtureMember, fixtureSession, fixtureResponse } from "./canonicalFixture.ts";
import { eq, getTableColumns, sql } from "drizzle-orm";
import { makeRealPorts } from "../../src/db/ports.real.ts";
import { assertNewNotificationPartLimit } from "../../src/features/result-notifications/render.ts";
import { sessions, responses, members, discordNotifications, discordNotificationAttendance, discordNotificationParts, heldEvents, heldEventParticipants } from "../../src/db/schema.ts";
import { attendanceMembers, type AttendanceHarness, type AttendanceSeed } from "../contracts/attendance.ts";
import { createIntegrationDb, truncatePerTestTables } from "./_support.ts";

export const createAttendanceHarness = () => {
  const { db, client } = createIntegrationDb({ maxConnections: 4 });
  const ports = makeRealPorts(db, payload => assertNewNotificationPartLimit(payload, "https://example.test"));
  const create = async (seed: AttendanceSeed = {}): Promise<AttendanceHarness> => {
    await truncatePerTestTables(db);
    for (const member of attendanceMembers) {
      await db.insert(members).values(fixtureMember(member)).onConflictDoUpdate({ target: members.id, set: { userId: member.userId, displayName: member.displayName } });
    }
    if (seed.sessions?.length) { await db.insert(sessions).values(seed.sessions.map(fixtureSession)); }
    if (seed.responses?.length) { await db.insert(responses).values(seed.responses.map(fixtureResponse)); }
    return { ports,
      snapshot: async () => ({ sessions: await db.select({ ...getTableColumns(sessions), id: sessions.legacyId }).from(sessions).orderBy(sessions.legacyId), responses: await db.select({ ...getTableColumns(responses), id: responses.legacyId, sessionId: sql<string>`(SELECT legacy_id FROM sessions WHERE id = ${responses.sessionId})`, memberId: sql<string>`(SELECT legacy_id FROM members WHERE id = ${responses.memberId})` }).from(responses).orderBy(responses.legacyId),
        notifications: await db.select().from(discordNotifications).orderBy(discordNotifications.id),
        attendance: await db.select().from(discordNotificationAttendance).orderBy(discordNotificationAttendance.notificationId),
        parts: await db.select().from(discordNotificationParts).orderBy(discordNotificationParts.notificationId),
        heldEvents: await db.select({ ...getTableColumns(heldEvents), id: heldEvents.legacyId, sessionId: sql<string | null>`(SELECT legacy_id FROM sessions WHERE id = ${heldEvents.sessionId})` }).from(heldEvents).orderBy(heldEvents.legacyId), participants: await db.select({ ...getTableColumns(heldEventParticipants), heldEventId: sql<string>`(SELECT legacy_id FROM held_events WHERE id = ${heldEventParticipants.heldEventId})`, memberId: sql<string>`(SELECT legacy_id FROM members WHERE id = ${heldEventParticipants.memberId})` }).from(heldEventParticipants).orderBy(heldEventParticipants.memberId) }),
      intents: async () => db.select({ sessionId: discordNotificationAttendance.sessionId, dedupeKey: discordNotifications.dedupeKey,
        aggregateRevision: discordNotificationAttendance.aggregateRevision, ordinal: discordNotificationAttendance.ordinal, payload: discordNotifications.payload })
        .from(discordNotifications).innerJoin(discordNotificationAttendance, eq(discordNotificationAttendance.notificationId, discordNotifications.id))
        .orderBy(discordNotificationAttendance.aggregateRevision, discordNotificationAttendance.ordinal)
    };
  };
  return { create, db, client };
};
