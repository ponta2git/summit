import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createAskSession,
  findDueStartupRecoverySessions,
  findMessageRecoveryCandidates,
  findSessionByWeekKeyAndPostponeCount,
  getSchedulerSessionHints
} from "../../src/db/repositories/sessions.js";
import { loadCurrentWeekSnapshot } from "../../src/db/repositories/status.js";
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

  it("loads current-week status details in one read model and excludes terminal POSTPONED rows", async () => {
    await db.execute(sql`
      INSERT INTO sessions
        (id, week_key, postpone_count, candidate_date_iso, status, channel_id, deadline_at,
         decided_start_at, reminder_at)
      VALUES
        ('status-asking', '2026-W17', 0, '2026-04-24', 'ASKING', 'c1', '2026-04-24T12:30:00Z', NULL, NULL),
        ('status-decided', '2026-W17', 1, '2026-04-25', 'DECIDED', 'c1', '2026-04-25T12:30:00Z', '2026-04-25T14:00:00Z', '2026-04-25T13:45:00Z'),
        ('status-cancelled', '2026-W18', 1, '2026-05-02', 'CANCELLED', 'c1', '2026-05-02T12:30:00Z', NULL, NULL),
        ('status-postponed', '2026-W18', 0, '2026-05-01', 'POSTPONED', 'c1', '2026-05-01T12:30:00Z', NULL, NULL),
        ('status-old', '2026-W16', 0, '2026-04-17', 'ASKING', 'c1', '2026-04-17T12:30:00Z', NULL, NULL)
    `);
    await db.execute(sql`
      INSERT INTO responses (id, session_id, member_id, choice)
      VALUES ('status-response', 'status-asking', 'm1', 'T2200')
    `);
    await db.execute(sql`
      INSERT INTO held_events (id, session_id, held_date_iso, start_at)
      VALUES ('status-held', 'status-decided', '2026-04-25', '2026-04-25T14:00:00Z')
    `);

    const snapshot = await loadCurrentWeekSnapshot(db, "2026-W17");

    expect(snapshot.sessions.map(({ session }) => session.id)).toStrictEqual([
      "status-asking",
      "status-decided"
    ]);
    expect(snapshot.sessions[0]?.responses.map((response) => response.id)).toStrictEqual([
      "status-response"
    ]);
    expect(snapshot.sessions[1]?.heldEvent?.id).toBe("status-held");
    expect(snapshot.strandedCancelled).toStrictEqual([]);
    const nextWeekSnapshot = await loadCurrentWeekSnapshot(db, "2026-W18");
    expect(nextWeekSnapshot.sessions).toStrictEqual([]);
    expect(nextWeekSnapshot.strandedCancelled.map((session) => session.id)).toStrictEqual([
      "status-cancelled"
    ]);
  });

  it("keeps startup due predicates and scheduler hints aligned with legacy reminder markers", async () => {
    const now = new Date("2026-04-24T12:30:00.000Z");
    await db.execute(sql`
      INSERT INTO sessions
        (id, week_key, postpone_count, candidate_date_iso, status, channel_id, deadline_at,
         reminder_at, reminder_sent_at)
      VALUES
        ('due-asking', '2026-W17', 0, '2026-04-24', 'ASKING', 'c1', '2026-04-24T12:29:00Z', NULL, NULL),
        ('due-postpone', '2026-W17', 1, '2026-04-25', 'POSTPONE_VOTING', 'c1', '2026-04-24T12:29:00Z', NULL, NULL),
        ('due-legacy-reminder', '2026-W18', 0, '2026-05-01', 'DECIDED', 'c1', '2026-05-01T12:00:00Z', '2026-04-24T12:29:00Z', '2026-04-24T12:00:00Z'),
        ('future-reminder', '2026-W19', 0, '2026-05-08', 'DECIDED', 'c1', '2026-05-08T12:00:00Z', '2026-04-24T12:31:00Z', NULL)
    `);

    expect((await findDueStartupRecoverySessions(db, now)).map((session) => session.id))
      .toStrictEqual(["due-asking", "due-postpone", "due-legacy-reminder"]);
    expect(await getSchedulerSessionHints(db, now)).toStrictEqual({
      nextAskingDeadlineAt: new Date("2026-04-24T12:29:00.000Z"),
      nextPostponeDeadlineAt: new Date("2026-04-24T12:29:00.000Z"),
      nextReminderAt: new Date("2026-04-24T12:29:00.000Z")
    });
  });

  it("keeps POSTPONED rows available to message recovery while excluding terminal rows", async () => {
    await db.execute(sql`
      INSERT INTO sessions
        (id, week_key, postpone_count, candidate_date_iso, status, channel_id, deadline_at)
      VALUES
        ('message-postponed', '2026-W17', 0, '2026-04-24', 'POSTPONED', 'c1', '2026-04-24T12:30:00Z'),
        ('message-completed', '2026-W18', 0, '2026-05-01', 'COMPLETED', 'c1', '2026-05-01T12:30:00Z')
    `);

    expect((await findMessageRecoveryCandidates(db)).map((session) => session.id))
      .toStrictEqual(["message-postponed"]);
  });
});
