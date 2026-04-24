import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createAskSession } from "../../src/db/repositories/sessions.js";
import {
  listResponses,
  upsertResponse
} from "../../src/db/repositories/responses.js";

import {
  assertSchemaReady,
  createIntegrationDb,
  isIntegration,
  seedBaseMembers,
  truncatePerTestTables
} from "./_support.js";

// invariant: INTEGRATION_DB=1 のときだけ実行する。gate は vitest.integration.config.ts の
//   include 側と二重化する。
const describeDb = isIntegration ? describe : describe.skip;

describeDb("responses repository contract (integration)", () => {
  const { db, client } = createIntegrationDb();

  const baseSession = {
    id: "sess-responses",
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

  it("listResponses returns [] when no rows exist for session", async () => {
    const rows = await listResponses(db, baseSession.id);
    expect(rows).toEqual([]);
  });

  // unique: (sessionId, memberId) unique で 1 メンバー 1 行に制約される。
  // idempotent: upsert の 2 回目は choice と answeredAt を最新値に上書きする。
  it("upsertResponse: second call for same member updates choice in-place (push-back)", async () => {
    await upsertResponse(db, {
      id: "r-first",
      sessionId: baseSession.id,
      memberId: "m1",
      choice: "T2200",
      answeredAt: new Date("2026-04-24T10:00:00.000Z")
    });

    const afterFirst = await listResponses(db, baseSession.id);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]?.choice).toBe("T2200");

    await upsertResponse(db, {
      id: "r-second",
      sessionId: baseSession.id,
      memberId: "m1",
      choice: "T2330",
      answeredAt: new Date("2026-04-24T10:05:00.000Z")
    });

    const afterSecond = await listResponses(db, baseSession.id);
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0]?.choice).toBe("T2330");
    expect(afterSecond[0]?.answeredAt.toISOString()).toBe(
      "2026-04-24T10:05:00.000Z"
    );
  });

  // race: 4 人が同じ session に別々に応答すると 4 行 独立して残る。
  it("upsertResponse: distinct members insert distinct rows", async () => {
    const memberIds = ["m1", "m2", "m3", "m4"] as const;
    await Promise.all(
      memberIds.map((memberId, i) =>
        upsertResponse(db, {
          id: `r-${memberId}`,
          sessionId: baseSession.id,
          memberId,
          choice: i % 2 === 0 ? "T2200" : "T2300",
          answeredAt: new Date("2026-04-24T10:10:00.000Z")
        })
      )
    );

    const rows = await listResponses(db, baseSession.id);
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((r) => r.memberId))).toEqual(new Set(memberIds));
  });

  // race: 同一 (sessionId, memberId) への並行 upsert が race しても、最終的に 1 行に収束する。
  it("upsertResponse: concurrent upserts for same (session, member) converge to a single row", async () => {
    const concurrency = 6;
    await Promise.all(
      Array.from({ length: concurrency }, (_, i) =>
        upsertResponse(db, {
          id: `r-race-${i}`,
          sessionId: baseSession.id,
          memberId: "m2",
          choice: i % 2 === 0 ? "T2230" : "T2300",
          answeredAt: new Date(Date.UTC(2026, 3, 24, 10, 0, i))
        })
      )
    );

    const rows = await listResponses(db, baseSession.id);
    expect(rows).toHaveLength(1);
    // invariant: choice は RESPONSE_CHOICES のいずれか。race 勝者の値に収束すれば良く、
    //   特定の値は保証しない。
    expect(["T2230", "T2300"]).toContain(rows[0]?.choice);
  });

  // regression: responses.choice CHECK 制約がドメイン層より先に invalid value を弾く。
  it("DB rejects invalid choice via CHECK constraint", async () => {
    let caught: unknown;
    try {
      await db.execute(sql`
        INSERT INTO responses (id, session_id, member_id, choice, answered_at)
        VALUES ('r-bad', ${baseSession.id}, 'm1', 'INVALID_CHOICE', now())
      `);
    } catch (err: unknown) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const cause =
      (caught as { cause?: { constraint_name?: string; message?: string } })
        .cause ?? {};
    const causeMsg = String(
      cause.constraint_name ?? cause.message ?? (caught as Error).message
    );
    expect(causeMsg).toContain("responses_choice_check");
  });
});
