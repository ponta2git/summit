import { sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  findDueStartupRecoverySessions,
  findMessageRecoveryCandidates,
  getSchedulerSessionHints
} from "../../src/db/repositories/sessions.js";
import { loadCurrentWeekSnapshot } from "../../src/db/repositories/status.js";
import { createIntegrationDb, isIntegration, seedBaseMembers, truncatePerTestTables } from "./_support.js";

const describeDb = isIntegration ? describe : describe.skip;

describeDb("sessions repository contract (integration)", () => {
  const { db } = createIntegrationDb();

  beforeAll(async () => {
    await seedBaseMembers(db);
  });

  beforeEach(async () => {
    await truncatePerTestTables(db);
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
            (id, legacy_id, week_key, postpone_count, candidate_date_iso, status, channel_id, deadline_at)
          VALUES
            (gen_random_uuid(), ${id}, '2026-W17', ${value}, '2026-04-24', 'ASKING', 'c1', now())
        `);
      } else {
        await db.execute(sql`
          INSERT INTO sessions
            (id, legacy_id, week_key, postpone_count, candidate_date_iso, status, channel_id, deadline_at, revision)
          VALUES
            (gen_random_uuid(), ${id}, '2026-W17', 0, '2026-04-24', 'ASKING', 'c1', now(), ${value})
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
    expect(await db.execute(sql`SELECT id FROM sessions WHERE legacy_id = ${id}`)).toHaveLength(0);
  });

  it("loads another week's active session and details while excluding terminal rows", async () => {
    await db.execute(sql`
      INSERT INTO sessions
        (id, legacy_id, week_key, candidate_date_iso, status, channel_id, deadline_at)
      VALUES
        (gen_random_uuid(), 'status-old', '2026-W16', '2026-04-17', 'ASKING', 'c1', '2026-04-17T12:30:00Z'),
        (gen_random_uuid(), 'status-postponed', '2026-W17', '2026-04-24', 'POSTPONED', 'c1', '2026-04-24T12:30:00Z'),
        (gen_random_uuid(), 'status-completed', '2026-W18', '2026-05-01', 'COMPLETED', 'c1', '2026-05-01T12:30:00Z')
    `);
    await db.execute(sql`
      INSERT INTO responses (id, legacy_id, session_id, member_id, choice)
      VALUES (gen_random_uuid(), 'status-response', (SELECT id FROM sessions WHERE legacy_id='status-old'), (SELECT id FROM members WHERE legacy_id='m1'), 'T2200')
    `);
    const snapshot = await loadCurrentWeekSnapshot(db, "2026-W17");
    expect(snapshot.sessions.map(({ session }) => session.id)).toStrictEqual(["status-old"]);
    expect(snapshot.sessions[0]?.responses.map(response => response.id)).toStrictEqual(["status-response"]);
    expect(snapshot.strandedCancelled).toStrictEqual([]);
    expect(snapshot.weeklyAuto).toBe("pending");

    await db.execute(sql`UPDATE sessions SET status = 'DECIDED', decided_start_at = '2026-04-17T14:00:00Z'
      WHERE legacy_id = 'status-old'`);
    await db.execute(sql`
      INSERT INTO held_events (id, legacy_id, session_id, held_date_iso, start_at)
      VALUES (gen_random_uuid(), 'status-held', (SELECT id FROM sessions WHERE legacy_id='status-old'), '2026-04-17', '2026-04-17T14:00:00Z')
    `);
    const decided = await loadCurrentWeekSnapshot(db, "2026-W18");
    expect(decided.sessions[0]?.session.status).toBe("DECIDED");
    expect(decided.sessions[0]?.heldEvent?.id).toBe("status-held");
    await db.execute(sql`UPDATE sessions SET status = 'CANCELLED' WHERE legacy_id = 'status-old'`);
    const cancelled = await loadCurrentWeekSnapshot(db, "2026-W18");
    expect(cancelled.sessions).toStrictEqual([]);
    expect(cancelled.strandedCancelled.map(session => session.id)).toStrictEqual(["status-old"]);
  });

  it.each(["ASKING", "POSTPONE_VOTING", "DECIDED"] as const)(
    "keeps startup due predicates and scheduler hints aligned for %s including legacy reminder markers", async status => {
      const now = new Date("2026-04-24T12:30:00.000Z");
      const due = new Date("2026-04-24T12:29:00.000Z");
      await db.execute(sql`INSERT INTO sessions
        (id, legacy_id, week_key, candidate_date_iso, status, channel_id, deadline_at, reminder_at, reminder_sent_at)
        VALUES (gen_random_uuid(), 'due-session', '2026-W17', '2026-04-24', ${status}, 'c1',
          ${due.toISOString()}, ${status === "DECIDED" ? due.toISOString() : null}, ${status === "DECIDED" ? now.toISOString() : null})`);
      expect((await findDueStartupRecoverySessions(db, now)).map(session => session.id)).toStrictEqual(["due-session"]);
      expect(await getSchedulerSessionHints(db, now)).toStrictEqual({
        nextAskingDeadlineAt: status === "ASKING" ? due : null,
        nextPostponeDeadlineAt: status === "POSTPONE_VOTING" ? due : null,
        nextReminderAt: status === "DECIDED" ? due : null
      });
      const future = new Date("2026-04-24T12:31:00.000Z");
      await db.execute(sql`UPDATE sessions SET deadline_at = ${future.toISOString()},
        reminder_at = ${status === "DECIDED" ? future.toISOString() : null} WHERE legacy_id = 'due-session'`);
      expect(await findDueStartupRecoverySessions(db, now)).toStrictEqual([]);
    }
  );

  it("reports only the requested week's automatic schedule without creating a Session", async () => {
    await db.execute(sql`INSERT INTO weekly_ask_schedules (week_key, disabled_at, disabled_by)
      VALUES ('2026-W17', '2026-04-24T12:00:00Z', 'user-1')`);
    expect(await loadCurrentWeekSnapshot(db, "2026-W17")).toStrictEqual({ weeklyAuto: "disabled", sessions: [], strandedCancelled: [] });
    expect(await loadCurrentWeekSnapshot(db, "2026-W18")).toStrictEqual({ weeklyAuto: "pending", sessions: [], strandedCancelled: [] });
    expect(await db.execute(sql`SELECT id FROM sessions`)).toHaveLength(0);
    await db.execute(sql`WITH generated AS (
      INSERT INTO sessions (id, legacy_id, week_key, candidate_date_iso, status, channel_id, deadline_at)
      VALUES (gen_random_uuid(), 'status-completed', '2026-W18', '2026-05-01', 'COMPLETED', 'c1', '2026-05-01T12:30:00Z')
      RETURNING id
    ) INSERT INTO weekly_ask_schedules (week_key, auto_session_id) SELECT '2026-W18', id FROM generated`);
    expect(await loadCurrentWeekSnapshot(db, "2026-W18")).toStrictEqual({ weeklyAuto: "created", sessions: [], strandedCancelled: [] });
    expect((await loadCurrentWeekSnapshot(db, "2026-W17")).weeklyAuto).toBe("disabled");
  });

  it("keeps POSTPONED rows available to message recovery while excluding terminal rows", async () => {
    await db.execute(sql`
      INSERT INTO sessions
        (id, legacy_id, week_key, postpone_count, candidate_date_iso, status, channel_id, deadline_at)
      VALUES
        (gen_random_uuid(), 'message-postponed', '2026-W17', 0, '2026-04-24', 'POSTPONED', 'c1', '2026-04-24T12:30:00Z'),
        (gen_random_uuid(), 'message-completed', '2026-W18', 0, '2026-05-01', 'COMPLETED', 'c1', '2026-05-01T12:30:00Z')
    `);

    expect((await findMessageRecoveryCandidates(db)).map((session) => session.id))
      .toStrictEqual(["message-postponed"]);
  });
});
