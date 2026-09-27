import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
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
  const { db, client } = createIntegrationDb();
  afterAll(() => client.end({ timeout: 5 }));

  it("reads index heads without scanning ten thousand completed sessions", async () => {
    await db.execute(sql`INSERT INTO sessions
      (id, week_key, candidate_date_iso, status, channel_id, deadline_at)
      SELECT 'history-' || n, 'history-' || n, '2026-04-24', 'COMPLETED', 'channel', '2026-04-24T12:30:00Z'
      FROM generate_series(1, 10000) AS n`);
    await db.execute(sql`INSERT INTO sessions
      (id, week_key, candidate_date_iso, status, channel_id, deadline_at, reminder_at)
      VALUES ('asking', 'asking', '2026-04-24', 'ASKING', 'channel', '2026-04-24T12:30:00Z', NULL),
        ('postpone', 'postpone', '2026-04-24', 'POSTPONE_VOTING', 'channel', '2026-04-24T15:00:00Z', NULL),
        ('decided', 'decided', '2026-04-24', 'DECIDED', 'channel', '2026-04-24T12:30:00Z', '2026-04-24T13:45:00Z')`);
    await db.execute(sql`ANALYZE sessions`);

    const execute = vi.spyOn(db, "execute");
    const hints = await getSchedulerSessionHints(db, new Date("2026-04-24T12:00:00Z"));
    const query = execute.mock.calls[0]?.[0];
    execute.mockRestore();
    expect(hints).toEqual({ nextAskingDeadlineAt: new Date("2026-04-24T12:30:00Z"),
      nextPostponeDeadlineAt: new Date("2026-04-24T15:00:00Z"), nextReminderAt: new Date("2026-04-24T13:45:00Z") });
    if (!query || typeof query === "string") { throw new Error("Expected parameterized scheduler query"); }
    const [row] = await db.execute<{ "QUERY PLAN": readonly { Plan: PlanNode }[] }>(
      sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`
    );
    const plan = row?.["QUERY PLAN"][0]?.Plan;
    if (!plan) { throw new Error("Expected an execution plan"); }
    const scans = flatten(plan).filter(node => node["Relation Name"] === "sessions");
    expect(scans).toHaveLength(3);
    expect(scans.every(node => ["Index Scan", "Index Only Scan"].includes(node["Node Type"]))).toBe(true);
    expect(scans.reduce((sum, node) => sum + node["Actual Rows"], 0)).toBeLessThanOrEqual(3);
  });
});
