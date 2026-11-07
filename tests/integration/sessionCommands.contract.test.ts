import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  cancelWeekAtomically,
  createSession,
  submitAskResponse
} from "../../src/db/repositories/sessionCommands.js";
import {
  createAskSession,
  findSessionById
} from "../../src/db/repositories/sessions.js";
import {
  completeDecidedSessionAsHeld,
  findHeldEventBySessionId
} from "../../src/db/repositories/heldEvents.js";
import { discordNotifications, discordNotificationAttendance, sessions, weeklyAskSchedules } from "../../src/db/schema.js";
import {
  createIntegrationDb,
  isIntegration,
  seedBaseMembers,
  truncatePerTestTables
} from "./_support.js";

const describeDb = isIntegration ? describe : describe.skip;

const baseSession = {
  weekKey: "2026-W17",
  postponeCount: 0,
  candidateDateIso: "2026-04-24",
  channelId: "channel-1",
  deadlineAt: new Date("2026-04-24T12:30:00.000Z")
} as const;

const cancelInput = {
  weekKey: baseSession.weekKey,
  candidateDateIso: baseSession.candidateDateIso,
  channelId: baseSession.channelId,
  deadlineAt: baseSession.deadlineAt,
  invokerUserId: "333333333333333333",
  suppressMentions: true,
  now: new Date("2026-04-24T12:00:00.000Z")
} as const;

describeDb("session aggregate command contract (integration)", () => {
  const primary = createIntegrationDb();
  const contender = createIntegrationDb();

  beforeAll(async () => {
    await seedBaseMembers(primary.db);
  });

  beforeEach(async () => {
    await truncatePerTestTables(primary.db);
  });

  it("keeps the highest Discord interaction snowflake under delayed delivery", async () => {
    await createAskSession(primary.db, { id: "10000000-0000-4000-a000-000000000021", ...baseSession });
    const common = {
      responseId: "10000000-0000-4000-a000-000000000022",
      sessionId: "10000000-0000-4000-a000-000000000021",
      memberId: "m1",
      now: new Date("2026-04-24T12:29:00.000Z"),
      memberCountExpected: 4
    } as const;

    const newer = await submitAskResponse(primary.db, {
      ...common,
      choice: "T2330",
      sourceInteractionId: "300"
    });
    const delayedOlder = await submitAskResponse(primary.db, {
      ...common,
      responseId: "10000000-0000-4000-a000-000000000023",
      choice: "T2200",
      sourceInteractionId: "200"
    });

    expect(newer.kind).toBe("accepted_pending");
    expect(delayedOlder).toMatchObject({
      kind: "stale_interaction",
      response: { choice: "T2330", sourceInteractionId: "300" }
    });
    expect(await findSessionById(primary.db, "10000000-0000-4000-a000-000000000021"))
      .toMatchObject({ status: "ASKING", revision: 1 });
  });

  it("persists ABSENT, final state, and ordered notices in one command", async () => {
    await createAskSession(primary.db, { id: "10000000-0000-4000-a000-000000000024", ...baseSession, source: "weekly_auto" });

    const result = await submitAskResponse(primary.db, {
      responseId: "10000000-0000-4000-a000-000000000025",
      sessionId: "10000000-0000-4000-a000-000000000024",
      memberId: "m1",
      choice: "ABSENT",
      sourceInteractionId: "400",
      now: new Date("2026-04-24T12:29:00.000Z"),
      memberCountExpected: 4
    });

    expect(result).toMatchObject({
      kind: "transitioned",
      outcome: "cancelled",
      session: {
        status: "POSTPONE_VOTING",
        cancelReason: "absent",
        revision: 2
      }
    });
    const intents = await primary.db
      .select({
        aggregateRevision: discordNotificationAttendance.aggregateRevision,
        ordinal: discordNotificationAttendance.ordinal,
        status: discordNotifications.status
      })
      .from(discordNotifications)
      .innerJoin(discordNotificationAttendance, eq(discordNotificationAttendance.notificationId, discordNotifications.id))
      .orderBy(discordNotificationAttendance.ordinal);
    expect(intents).toStrictEqual([
      { aggregateRevision: 2, ordinal: 0, status: "PENDING" },
      { aggregateRevision: 2, ordinal: 1, status: "PENDING" }
    ]);
  });

  it("serializes weekly creation against stopping the uncreated weekly ask", async () => {
    const [cancelled, created] = await Promise.all([
      cancelWeekAtomically(primary.db, cancelInput),
      createSession(contender.db, { id: "10000000-0000-4000-a000-000000000026", source: "weekly_auto", channelId: "channel-1", now: cancelInput.now })
    ]);
    const rows = await primary.db.select().from(sessions);
    const outcome = { cancelled: cancelled.kind, created: created.kind,
      reason: created.kind === "rejected" ? created.reason : null,
      rows: rows.map(row => ({ status: row.status, source: row.source })) };
    expect([
      { cancelled: "applied", created: "rejected", reason: "auto_disabled", rows: [] },
      { cancelled: "already_started", created: "created", reason: null, rows: [{ status: "ASKING", source: "weekly_auto" }] }
    ]).toContainEqual(outcome);
    expect(await primary.db.select().from(discordNotifications)).toHaveLength(1);
  });

  it.each(["absent", "pending"] as const)("disables an %s weekly schedule once and preserves its audit timestamps on replay", async state => {
    const createdAt = state === "pending" ? new Date("2026-04-20T00:00:00Z") : cancelInput.now;
    if (state === "pending") {
      await primary.db.insert(weeklyAskSchedules).values({ weekKey: baseSession.weekKey, createdAt, updatedAt: createdAt });
    }
    expect(await cancelWeekAtomically(primary.db, cancelInput)).toMatchObject({ kind: "applied", noticeEnqueued: true });
    const before = await primary.db.select().from(weeklyAskSchedules);
    expect(before).toEqual([{
      weekKey: baseSession.weekKey, createdAt, updatedAt: cancelInput.now,
      autoSessionId: null, disabledAt: cancelInput.now, disabledBy: cancelInput.invokerUserId
    }]);
    expect(await cancelWeekAtomically(primary.db, { ...cancelInput, invokerUserId: "another-user", now: new Date("2026-04-24T12:01:00Z") }))
      .toMatchObject({ kind: "already_disabled", noticeEnqueued: false });
    expect(await primary.db.select().from(weeklyAskSchedules)).toEqual(before);
    expect(await primary.db.select().from(discordNotifications)).toHaveLength(1);
  });

  it.each(["absent", "pending"] as const)("assigns an %s weekly schedule to its auto Session once", async state => {
    const createdAt = state === "pending" ? new Date("2026-04-20T00:00:00Z") : cancelInput.now;
    if (state === "pending") {
      await primary.db.insert(weeklyAskSchedules).values({ weekKey: baseSession.weekKey, createdAt, updatedAt: createdAt });
    }
    const input = { id: "10000000-0000-4000-a000-000000000028", source: "weekly_auto" as const,
      channelId: baseSession.channelId, now: cancelInput.now };
    expect(await createSession(primary.db, input)).toMatchObject({ kind: "created", session: { id: input.id } });
    const before = await primary.db.select().from(weeklyAskSchedules);
    expect(before).toEqual([{
      weekKey: baseSession.weekKey, createdAt, updatedAt: cancelInput.now,
      autoSessionId: input.id, disabledAt: null, disabledBy: null
    }]);
    expect(await createSession(primary.db, { ...input, now: new Date("2026-04-24T12:01:00Z") }))
      .toEqual({ kind: "rejected", reason: "auto_started" });
    expect(await primary.db.select().from(weeklyAskSchedules)).toEqual(before);
    expect(await primary.db.select().from(discordNotifications)).toHaveLength(1);
  });

  it("cancel_week and HeldEvent completion never produce SKIPPED plus HeldEvent", async () => {
    await createAskSession(primary.db, { id: "10000000-0000-4000-a000-000000000027", ...baseSession });
    const decidedStartAt = new Date("2026-04-24T14:00:00.000Z");
    await primary.db
      .update(sessions)
      .set({
        status: "DECIDED",
        decidedStartAt,
        reminderAt: new Date("2026-04-24T13:45:00.000Z"),
        revision: 1
      })
      .where(eq(sessions.legacyId, "10000000-0000-4000-a000-000000000027"));

    await Promise.all([
      cancelWeekAtomically(primary.db, {
        ...cancelInput
      }),
      completeDecidedSessionAsHeld(contender.db, {
        sessionId: "10000000-0000-4000-a000-000000000027",
        reminderSentAt: new Date("2026-04-24T13:45:01.000Z"),
        memberIds: ["m1"]
      })
    ]);

    const persisted = await findSessionById(primary.db, "10000000-0000-4000-a000-000000000027");
    const held = await findHeldEventBySessionId(primary.db, "10000000-0000-4000-a000-000000000027");
    expect(persisted?.status).toBe("COMPLETED");
    expect(held).toBeDefined();
  });
});
