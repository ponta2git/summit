import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  completeDecidedSessionAsHeld,
  findHeldEventBySessionId,
  listHeldEventParticipants
} from "../../src/db/repositories/heldEvents.js";
import {
  createAskSession,
  decideAsking
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
    const decided = await decideAsking(db, {
      id: baseSession.id,
      now: new Date("2026-04-24T12:31:00.000Z"),
      decidedStartAt: new Date("2026-04-24T14:00:00.000Z"),
      reminderAt: new Date("2026-04-24T13:45:00.000Z")
    });
    if (!decided) {
      throw new Error("decide setup failed");
    }
  };

  // tx: DECIDED→COMPLETED と held_events / held_event_participants 挿入を 1 tx で束ねる。
  it("completeDecidedSessionAsHeld: transitions DECIDED→COMPLETED and inserts held_event + participants", async () => {
    await decide();

    const result = await completeDecidedSessionAsHeld(db, {
      sessionId: baseSession.id,
      reminderSentAt: new Date("2026-04-24T13:45:01.000Z"),
      memberIds: ["m1", "m2", "m3", "m4"]
    });
    expect(result).toBeDefined();
    expect(result?.session.status).toBe("COMPLETED");
    expect(result?.heldEvent.sessionId).toBe(baseSession.id);
    // invariant: heldDateIso / startAt は session からリポジトリ内で導出する。
    expect(result?.heldEvent.heldDateIso).toBe(baseSession.candidateDateIso);
    expect(result?.heldEvent.startAt.toISOString()).toBe(
      "2026-04-24T14:00:00.000Z"
    );
    expect(result?.participants).toHaveLength(4);

    const participants = await listHeldEventParticipants(
      db,
      result!.heldEvent.id
    );
    expect(participants).toHaveLength(4);
  });

  // race: CAS 敗北時 (既に COMPLETED) は undefined を返し、held_events を書き込まない。
  it("completeDecidedSessionAsHeld: returns undefined when status is not DECIDED (race lost)", async () => {
    await decide();
    const first = await completeDecidedSessionAsHeld(db, {
      sessionId: baseSession.id,
      reminderSentAt: new Date("2026-04-24T13:45:01.000Z"),
      memberIds: ["m1"]
    });
    expect(first).toBeDefined();

    const second = await completeDecidedSessionAsHeld(db, {
      sessionId: baseSession.id,
      reminderSentAt: new Date("2026-04-24T13:46:00.000Z"),
      memberIds: ["m2"]
    });
    expect(second).toBeUndefined();

    // idempotent: 既存の held_event / participants は保持される。
    const held = await findHeldEventBySessionId(db, baseSession.id);
    expect(held).toBeDefined();
    const participants = await listHeldEventParticipants(db, held!.id);
    expect(participants.map((p) => p.memberId)).toEqual(["m1"]);
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

    const held = await findHeldEventBySessionId(db, baseSession.id);
    expect(held).toBeDefined();

    // invariant: winner の participants のみ書き込まれる。loser の memberIds は反映されない。
    const participants = await listHeldEventParticipants(db, held!.id);
    expect(participants).toHaveLength(2);
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
    expect(result?.session.status).toBe("COMPLETED");
    expect(result?.participants).toEqual([]);

    const [row] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, baseSession.id));
    expect(row?.status).toBe("COMPLETED");
    expect(row?.reminderSentAt?.toISOString()).toBe(
      "2026-04-24T13:45:01.000Z"
    );
  });
});
