import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  completeDecidedSessionAsHeld,
  findHeldEventBySessionId,
  listHeldEventParticipants
} from "../../src/db/repositories/heldEvents.js";
import {
  createAskSession
} from "../../src/db/repositories/sessions.js";
import { sessions } from "../../src/db/schema.js";

import {
  assertSchemaReady,
  createIntegrationDb,
  isIntegration,
  seedBaseMembers,
  truncatePerTestTables
} from "./_support.js";

const describeDb = isIntegration ? describe : describe.skip;

describeDb("heldEvents repository contract (integration)", () => {
  const { db, client } = createIntegrationDb();

  const baseSession = {
    id: "sess-held",
    weekKey: "2026-W17",
    postponeCount: 0,
    candidateDateIso: "2026-04-24",
    channelId: "channel-1",
    deadlineAt: new Date("2026-04-24T12:30:00.000Z")
  } as const;

  beforeAll(async () => {
    await assertSchemaReady(db);
    await seedBaseMembers(db);
  });

  beforeEach(async () => {
    await truncatePerTestTables(db);
    await createAskSession(db, { ...baseSession });
  });

  afterAll(async () => {
    await client.end({ timeout: 5 });
  });

  const decide = async (): Promise<void> => {
    await db
      .update(sessions)
      .set({
        status: "DECIDED",
        decidedStartAt: new Date("2026-04-24T14:00:00.000Z"),
        reminderAt: new Date("2026-04-24T13:45:00.000Z"),
        revision: 1,
        updatedAt: new Date("2026-04-24T12:31:00.000Z")
      })
      .where(eq(sessions.id, baseSession.id));
  };

  // tx: DECIDED→COMPLETED と held_events / held_event_participants 挿入を 1 tx で束ねる。
  it("completeDecidedSessionAsHeld: transitions DECIDED→COMPLETED and inserts held_event + participants", async () => {
    await decide();

    const result = await completeDecidedSessionAsHeld(db, {
      sessionId: baseSession.id,
      reminderSentAt: new Date("2026-04-24T13:45:01.000Z"),
      memberIds: ["m1", "m2", "m3", "m4"]
    });
    if (!result) {throw new Error("expected held-event completion to win CAS");}
    expect({
      sessionStatus: result.session.status,
      reminderSentAt: result.session.reminderSentAt,
      heldSessionId: result.heldEvent.sessionId,
      heldDateIso: result.heldEvent.heldDateIso,
      startAt: result.heldEvent.startAt,
      participantMemberIds: result.participants.map((participant) => participant.memberId)
    }).toStrictEqual({
      sessionStatus: "COMPLETED",
      reminderSentAt: new Date("2026-04-24T13:45:01.000Z"),
      heldSessionId: baseSession.id,
      heldDateIso: baseSession.candidateDateIso,
      startAt: new Date("2026-04-24T14:00:00.000Z"),
      participantMemberIds: ["m1", "m2", "m3", "m4"]
    });

    expect((await listHeldEventParticipants(db, result.heldEvent.id)).map((row) => row.memberId))
      .toStrictEqual(["m1", "m2", "m3", "m4"]);
  });

  // race: CAS 敗北時 (既に COMPLETED) は undefined を返し、held_events を書き込まない。
  it("completeDecidedSessionAsHeld: returns undefined when status is not DECIDED (race lost)", async () => {
    await decide();
    const first = await completeDecidedSessionAsHeld(db, {
      sessionId: baseSession.id,
      reminderSentAt: new Date("2026-04-24T13:45:01.000Z"),
      memberIds: ["m1"]
    });
    if (!first) {throw new Error("expected first completion to win CAS");}

    const second = await completeDecidedSessionAsHeld(db, {
      sessionId: baseSession.id,
      reminderSentAt: new Date("2026-04-24T13:46:00.000Z"),
      memberIds: ["m2"]
    });
    expect(second).toBeUndefined();

    // idempotent: 既存の held_event / participants は保持される。
    const held = await findHeldEventBySessionId(db, baseSession.id);
    expect(held?.id).toBe(first.heldEvent.id);
    const participants = await listHeldEventParticipants(db, first.heldEvent.id);
    expect(participants.map((participant) => participant.memberId)).toStrictEqual(["m1"]);
  });

  // race: 並行 complete で 1 件の held_event に収束する。
  it("completeDecidedSessionAsHeld: concurrent completes converge to a single held_event", async () => {
    await decide();
    const [a, b] = await Promise.all([
      completeDecidedSessionAsHeld(db, {
        sessionId: baseSession.id,
        reminderSentAt: new Date("2026-04-24T13:45:01.000Z"),
        memberIds: ["m1", "m2"]
      }),
      completeDecidedSessionAsHeld(db, {
        sessionId: baseSession.id,
        reminderSentAt: new Date("2026-04-24T13:45:02.000Z"),
        memberIds: ["m3", "m4"]
      })
    ]);
    const winners = [a, b].filter((r) => r !== undefined);
    expect(winners).toHaveLength(1);
    const winner = winners[0];
    if (!winner) {throw new Error("expected one concurrent completion winner");}

    const held = await findHeldEventBySessionId(db, baseSession.id);
    expect(held?.id).toBe(winner.heldEvent.id);
    expect((await listHeldEventParticipants(db, winner.heldEvent.id)).map((row) => row.memberId))
      .toStrictEqual(winner.participants.map((row) => row.memberId));
  });

  // edge: memberIds が空でも COMPLETED 遷移と held_event 作成は成立する (全員欠席でも開催扱いはしない想定だが
  //   仕様上の phase transition としては許容)。
  it("completeDecidedSessionAsHeld: empty memberIds still completes session and records held_event", async () => {
    await decide();
    const result = await completeDecidedSessionAsHeld(db, {
      sessionId: baseSession.id,
      reminderSentAt: new Date("2026-04-24T13:45:01.000Z"),
      memberIds: []
    });
    expect({ status: result?.session.status, participants: result?.participants })
      .toStrictEqual({ status: "COMPLETED", participants: [] });

    const [row] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, baseSession.id));
    expect({ status: row?.status, reminderSentAt: row?.reminderSentAt }).toStrictEqual({
      status: "COMPLETED",
      reminderSentAt: new Date("2026-04-24T13:45:01.000Z")
    });
  });
});
