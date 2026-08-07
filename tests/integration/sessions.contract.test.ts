import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createAskSession,
  findSessionByWeekKeyAndPostponeCount
} from "../../src/db/repositories/sessions.js";
import { baseSession, createSessionsContractHarness } from "./_sessionsContract.js";
import { isIntegration } from "./_support.js";

const describeDb = isIntegration ? describe : describe.skip;

describeDb("sessions repository contract (integration)", () => {
  const harness = createSessionsContractHarness();
  const { db } = harness;

  beforeAll(async () => {
    await harness.initialize();
  });

  beforeEach(async () => {
    await harness.reset();
  });

  afterAll(async () => {
    await harness.close();
  });

  it("createAskSession deduplicates (weekKey, postponeCount)", async () => {
    const first = await createAskSession(db, { id: "s1", ...baseSession });
    const second = await createAskSession(db, { id: "s2", ...baseSession });
    const persisted = await findSessionByWeekKeyAndPostponeCount(db, baseSession.weekKey, 0);

    expect({ firstId: first?.id, second, persistedId: persisted?.id }).toStrictEqual({
      firstId: "s1",
      second: undefined,
      persistedId: "s1"
    });
  });

  it.each([
    {
      id: "s-bad-postpone",
      column: "postpone_count",
      value: 2,
      constraint: "sessions_postpone_count_check"
    },
    {
      id: "s-bad-revision",
      column: "revision",
      value: -1,
      constraint: "sessions_revision_check"
    }
  ])("rejects invalid $column with its database CHECK", async ({
    id,
    column,
    value,
    constraint
  }) => {
    let caught: unknown;
    try {
      if (column === "postpone_count") {
        await db.execute(sql`
          INSERT INTO sessions
            (id, week_key, postpone_count, candidate_date_iso, status, channel_id, deadline_at)
          VALUES
            (${id}, '2026-W17', ${value}, '2026-04-24', 'ASKING', 'c1', now())
        `);
      } else {
        await db.execute(sql`
          INSERT INTO sessions
            (id, week_key, postpone_count, candidate_date_iso, status, channel_id, deadline_at, revision)
          VALUES
            (${id}, '2026-W17', 0, '2026-04-24', 'ASKING', 'c1', now(), ${value})
        `);
      }
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const causeMessage = String(
      (caught as { cause?: { constraint_name?: string; message?: string } }).cause
        ?.constraint_name ??
        (caught as { cause?: { message?: string } }).cause?.message ??
        (caught as Error).message
    );
    expect(causeMessage).toContain(constraint);
    expect(await db.execute(sql`SELECT id FROM sessions WHERE id = ${id}`)).toHaveLength(0);
  });
});
