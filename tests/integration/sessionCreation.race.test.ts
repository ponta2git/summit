import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createSession, submitPostponeVote } from "../../src/db/repositories/sessionCommands.ts";
import { sessions, responses, discordNotifications, weeklyAskSchedules } from "../../src/db/schema.ts";
import { createIntegrationDb, isIntegration, seedBaseMembers, truncatePerTestTables } from "./_support.ts";
import { fixtureSession, fixtureResponse } from "./canonicalFixture.ts";
import { fridayPostponeVoting } from "../testing/sessionScenario.ts";
import { makeResponse } from "../testing/fixtures.ts";
import { deferred } from "../helpers/deferred.ts";
import { waitForBlockedBy, waitForLockWaiters } from "./locking.ts";

(isIntegration ? describe : describe.skip)("session creation arbitration", () => {
  const { db, client } = createIntegrationDb({ maxConnections: 4 });
  const now = new Date("2026-04-24T10:00:00+09:00");
  beforeEach(async () => { await truncatePerTestTables(db); await seedBaseMembers(db); });

  it.each(["manual", "weekly_auto"] as const)("elects one Session and one intent when manual races %s", async source => {
    const results = await Promise.all([
      createSession(db, { id: randomUUID(), source: "manual", channelId: "channel", now }),
      createSession(db, { id: randomUUID(), source, channelId: "channel", now })
    ]);
    expect(results.map(result => result.kind).sort()).toEqual(["created", "rejected"]);
    expect(results.filter(result => result.kind === "rejected").map(result => result.reason)).toEqual(["date_exists"]);
    expect(await db.select().from(sessions)).toHaveLength(1);
    expect(await db.select().from(discordNotifications)).toHaveLength(1);
  });

  it("replays the same request atomically and rejects different dates across ISO weeks while one is active", async () => {
    const first = { id: randomUUID(), source: "manual" as const, requestId: "same-operation", channelId: "channel", now };
    const replay = await Promise.all([createSession(db, first), createSession(db, { ...first, id: randomUUID() })]);
    expect(replay.map(result => result.kind).sort()).toEqual(["created", "duplicate"]);
    const winningId = replay.find(result => result.kind === "created")?.session?.id;
    expect(winningId).toBeDefined();
    expect(replay.map(result => result.session?.id)).toEqual([winningId, winningId]);
    expect(await createSession(db, { ...first, id: randomUUID(), requestId: "other-operation", now: new Date("2026-04-27T10:00:00+09:00") }))
      .toMatchObject({ kind: "rejected", reason: "active_session", session: { id: winningId } });
    expect(await db.select().from(discordNotifications)).toHaveLength(1);
  });

  it("rolls back creation when an outside writer disables the schedule after admission reads it", async () => {
    const weekKey = "2026-W17";
    await db.insert(weeklyAskSchedules).values({ weekKey });
    const locked = deferred<number>(); const release = deferred<void>();
    const blocker = db.transaction(async tx => {
      await tx.update(weeklyAskSchedules).set({ disabledAt: now, disabledBy: "outside-writer" })
        .where(eq(weeklyAskSchedules.weekKey, weekKey));
      const [backend] = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      if (!backend) { throw new Error("Missing backend"); }
      locked.resolve(backend.pid); await release.promise;
    });
    const pid = await locked.promise;
    // Observe failure immediately, including if lock observation itself fails.
    const creation = createSession(db, { id: randomUUID(), source: "weekly_auto", channelId: "channel", now })
      .then(result => ({ result }), (error: unknown) => ({ error }));
    try { await waitForBlockedBy(client, pid); }
    finally { release.resolve(); await Promise.allSettled([blocker, creation]); }
    await blocker;
    expect(await creation).toMatchObject({ error: { message: "Weekly ask schedule changed during creation" } });
    expect(await db.select().from(weeklyAskSchedules)).toMatchObject([{ weekKey, autoSessionId: null,
      disabledAt: now, disabledBy: "outside-writer" }]);
    expect(await db.select().from(sessions)).toEqual([]);
    expect(await db.select().from(discordNotifications)).toEqual([]);
  });

  it("holds the creation gate through parent termination and Saturday insertion", async () => {
    const parent = fridayPostponeVoting({ id: "parent" });
    await db.insert(sessions).values(fixtureSession(parent));
    await db.insert(responses).values(["m2", "m3", "m4"].map(memberId => fixtureResponse(makeResponse({
      id: `vote-${memberId}`, sessionId: parent.id, memberId, choice: "POSTPONE_OK"
    }))));
    const locked = deferred<number>(); const release = deferred<void>();
    const blocker = db.transaction(async tx => {
      await tx.select().from(sessions).where(eq(sessions.legacyId, parent.id)).for("update");
      const [backend] = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      if (!backend) { throw new Error("Missing backend"); }
      locked.resolve(backend.pid); await release.promise;
    });
    const pid = await locked.promise;
    const saturdayId = randomUUID();
    const vote = submitPostponeVote(db, { responseId: randomUUID(), sessionId: parent.id, memberId: "m1", sourceInteractionId: "500",
      now, memberCountExpected: 4, choice: "POSTPONE_OK", saturday: { id: saturdayId, candidateDateIso: "2026-04-25", deadlineAt: new Date("2026-04-25T21:30:00+09:00") } });
    let manual: ReturnType<typeof createSession> | undefined;
    try {
      await waitForBlockedBy(client, pid);
      manual = createSession(db, { id: randomUUID(), source: "manual", channelId: "channel", now: new Date("2026-04-26T10:00:00+09:00") });
      await waitForLockWaiters(client, 2);
    } finally {
      release.resolve(); await Promise.allSettled([blocker, vote, manual]);
    }
    expect(await vote).toMatchObject({ kind: "transitioned", outcome: "all_ok", session: { status: "POSTPONED" },
      saturdaySession: { id: saturdayId, source: "postponed", parentSessionId: parent.id } });
    expect(await manual).toMatchObject({ kind: "rejected", reason: "active_session", session: { id: saturdayId } });
    expect(await db.select().from(discordNotifications)).toHaveLength(1);
  });
});
