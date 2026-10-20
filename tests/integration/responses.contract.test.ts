import { sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { listResponses } from "../../src/db/repositories/responses.js";
import { createAskSession } from "../../src/db/repositories/sessions.js";
import {
  createIntegrationDb,
  isIntegration,
  seedBaseMembers,
  truncatePerTestTables
} from "./_support.js";

const describeDb = isIntegration ? describe : describe.skip;

describeDb("responses read repository and schema contract (integration)", () => {
  const { db } = createIntegrationDb();
  const session = {
    id: "10000000-0000-4000-a000-000000000003",
    weekKey: "2026-W17",
    postponeCount: 0,
    candidateDateIso: "2026-04-24",
    channelId: "channel-1",
    deadlineAt: new Date("2026-04-24T12:30:00.000Z")
  } as const;

  beforeAll(async () => {
    await seedBaseMembers(db);
  });

  beforeEach(async () => {
    await truncatePerTestTables(db);
    await createAskSession(db, session);
  });

  it("returns no rows for an unanswered Session", async () => {
    expect(await listResponses(db, session.id)).toStrictEqual([]);
  });

  it("rejects an invalid choice at the database boundary", async () => {
    await expect(db.execute(sql`
        INSERT INTO responses (id, legacy_id, session_id, member_id, choice, answered_at)
        VALUES (gen_random_uuid(), 'r-bad', ${session.id}, (SELECT id FROM members WHERE legacy_id='m1'), 'INVALID_CHOICE', now())
      `)).rejects.toMatchObject({ cause: { code: "23514", constraint_name: "responses_choice_check" } });
  });
});
