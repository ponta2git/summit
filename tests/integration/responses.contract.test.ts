import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { listResponses } from "../../src/db/repositories/responses.js";
import { createAskSession } from "../../src/db/repositories/sessions.js";
import {
  assertSchemaReady,
  createIntegrationDb,
  isIntegration,
  seedBaseMembers,
  truncatePerTestTables
} from "./_support.js";

const describeDb = isIntegration ? describe : describe.skip;

describeDb("responses read repository and schema contract (integration)", () => {
  const { db, client } = createIntegrationDb();
  const session = {
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
    await createAskSession(db, session);
  });

  afterAll(async () => {
    await client.end({ timeout: 5 });
  });

  it("returns no rows for an unanswered Session", async () => {
    expect(await listResponses(db, session.id)).toStrictEqual([]);
  });

  it("rejects an invalid choice at the database boundary", async () => {
    let caught: unknown;
    try {
      await db.execute(sql`
        INSERT INTO responses (id, session_id, member_id, choice, answered_at)
        VALUES ('r-bad', ${session.id}, 'm1', 'INVALID_CHOICE', now())
      `);
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const cause =
      (caught as { cause?: { constraint_name?: string; message?: string } }).cause ?? {};
    expect(String(cause.constraint_name ?? cause.message ?? (caught as Error).message))
      .toContain("responses_choice_check");
  });
});
