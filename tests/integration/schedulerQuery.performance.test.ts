import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { getSchedulerSessionHints } from "../../src/db/repositories/sessions.ts";
import { createIntegrationDb, isIntegration } from "./_support.ts";

interface PlanNode {
  readonly "Node Type": string;
  readonly "Relation Name"?: string;
  readonly "Actual Rows": number;
  readonly Plans?: readonly PlanNode[];
}

const flatten = (plan: PlanNode): readonly PlanNode[] => [plan, ...(plan.Plans ?? []).flatMap(flatten)];

(isIntegration ? describe : describe.skip)("scheduler discovery under retained history", () => {
  const { db } = createIntegrationDb();

  it("reads index heads without scanning ten thousand completed sessions", async () => {
    await db.execute(sql`INSERT INTO sessions
      (id, legacy_id, week_key, candidate_date_iso, status, channel_id, deadline_at)
      SELECT gen_random_uuid(), 'history-' || n, to_char(DATE '2026-04-24' - n, 'IYYY-"W"IW'),
        DATE '2026-04-24' - n, 'COMPLETED', 'channel',
        ((DATE '2026-04-24' - n) + TIME '12:30:00') AT TIME ZONE 'UTC'
      FROM generate_series(1, 10000) AS n`);
    await db.execute(sql`INSERT INTO sessions
      (id, legacy_id, week_key, candidate_date_iso, status, channel_id, deadline_at, reminder_at)
      VALUES (gen_random_uuid(), 'active', '2026-W17', '2026-04-24', 'ASKING', 'channel', '2026-04-24T12:30:00Z', NULL)`);
    await db.execute(sql`ANALYZE sessions`);

    // Only one active Session may exist; exercise each scheduler phase in turn.
    for (const status of ["ASKING", "POSTPONE_VOTING", "DECIDED"] as const) {
      const deadline = status === "POSTPONE_VOTING" ? "2026-04-24T15:00:00Z" : "2026-04-24T12:30:00Z";
      const reminder = status === "DECIDED" ? "2026-04-24T13:45:00Z" : null;
      await db.execute(sql`UPDATE sessions SET status=${status}, deadline_at=${deadline}, reminder_at=${reminder}
        WHERE legacy_id='active'`);
      const execute = vi.spyOn(db, "execute");
      const hints = await getSchedulerSessionHints(db, new Date("2026-04-24T12:00:00Z"));
      const query = execute.mock.calls[0]?.[0];
      execute.mockRestore();
      expect(hints).toEqual({
        nextAskingDeadlineAt: status === "ASKING" ? new Date("2026-04-24T12:30:00Z") : null,
        nextPostponeDeadlineAt: status === "POSTPONE_VOTING" ? new Date("2026-04-24T15:00:00Z") : null,
        nextReminderAt: status === "DECIDED" ? new Date("2026-04-24T13:45:00Z") : null
      });
      if (!query || typeof query === "string") { throw new Error("Expected parameterized scheduler query"); }
      const [row] = await db.execute<{ "QUERY PLAN": readonly { Plan: PlanNode }[] }>(
        sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`
      );
      const plan = row?.["QUERY PLAN"][0]?.Plan;
      if (!plan) { throw new Error("Expected an execution plan"); }
      const scans = flatten(plan).filter(node => node["Relation Name"] === "sessions");
      expect(scans).toHaveLength(3);
      expect(scans.every(node => ["Index Scan", "Index Only Scan"].includes(node["Node Type"]))).toBe(true);
      expect(scans.reduce((sum, node) => sum + node["Actual Rows"], 0)).toBeLessThanOrEqual(1);
    }
  });
});
