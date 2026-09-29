import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type postgres from "postgres";
import { z } from "zod";
import { requireLocalTestUrl } from "../../tests/integration/databaseLifecycle.ts";
import { CapacityError } from "../verify/notificationCapacity.contract.ts";
import { performanceStage } from "./notificationPerformance.contract.ts";
import { createPerformanceOutput, performanceRoot, withPerformanceDatabase, writePerformanceArtifact } from "./notificationPerformance.storage.ts";

type Operation = "begin" | "complete";
const fixtures = [112, 8_823].flatMap(partCount => [
  { position: "first", frontier: 0 }, { position: "middle", frontier: Math.floor(partCount / 2) },
  { position: "last", frontier: partCount - 1 }
].map(value => ({ ...value, partCount, id: `explain-parts-${partCount}-${value.position}` })));
type Fixture = typeof fixtures[number];

// The two SELECTs in notifications.delivery.ts, including their absence of
// ORDER BY. All SQL is fixed here; even synthetic fixture values are bound.
const statements = {
  begin: 'SELECT "part_no" FROM "discord_notification_parts" WHERE ("discord_notification_parts"."notification_id" = $1 AND "discord_notification_parts"."part_no" < $2 AND "discord_notification_parts"."status" <> $3) LIMIT $4',
  complete: 'SELECT "part_no" FROM "discord_notification_parts" WHERE ("discord_notification_parts"."notification_id" = $1 AND "discord_notification_parts"."status" <> $2) LIMIT $3'
} as const;
const parameters = (fixture: Fixture, operation: Operation): (string | number)[] => operation === "begin"
  ? [fixture.id, fixture.frontier, "DELIVERED", 1] : [fixture.id, "DELIVERED", 1];

const nonnegative = z.number().finite().nonnegative();
const planSchema = z.array(z.object({
  Plan: z.unknown(), "Planning Time": nonnegative, "Execution Time": nonnegative
}).passthrough()).length(1);
const nodeSchema = z.object({
  "Node Type": z.string(), "Actual Rows": nonnegative, "Actual Loops": nonnegative,
  "Relation Name": z.string().optional(), "Index Name": z.string().optional(),
  "Index Cond": z.string().optional(), Filter: z.string().optional(),
  "Rows Removed by Filter": nonnegative.optional(), "Rows Removed by Index Recheck": nonnegative.optional(),
  "Shared Hit Blocks": nonnegative.optional(), "Shared Read Blocks": nonnegative.optional(),
  "Shared Dirtied Blocks": nonnegative.optional(), "Shared Written Blocks": nonnegative.optional(),
  "Temp Read Blocks": nonnegative.optional(), "Temp Written Blocks": nonnegative.optional(),
  Plans: z.array(z.unknown()).optional()
});
type NodeSummary = {
  path: string; type: string; relation: string | null; index: string | null;
  indexCondition: string | null; filter: string | null; actualRowsPerLoop: number; actualLoops: number;
  rowsRemovedByFilterPerLoop: number; rowsRemovedByIndexRecheckPerLoop: number;
  buffers: { sharedHit: number; sharedRead: number; sharedDirtied: number; sharedWritten: number; tempRead: number; tempWritten: number };
};
const summarizeNodes = (value: unknown, path = "0"): NodeSummary[] => {
  const node = nodeSchema.parse(value);
  return [{ path, type: node["Node Type"], relation: node["Relation Name"] ?? null, index: node["Index Name"] ?? null,
    indexCondition: node["Index Cond"] ?? null, filter: node.Filter ?? null,
    actualRowsPerLoop: node["Actual Rows"], actualLoops: node["Actual Loops"],
    rowsRemovedByFilterPerLoop: node["Rows Removed by Filter"] ?? 0,
    rowsRemovedByIndexRecheckPerLoop: node["Rows Removed by Index Recheck"] ?? 0,
    buffers: { sharedHit: node["Shared Hit Blocks"] ?? 0, sharedRead: node["Shared Read Blocks"] ?? 0,
      sharedDirtied: node["Shared Dirtied Blocks"] ?? 0, sharedWritten: node["Shared Written Blocks"] ?? 0,
      tempRead: node["Temp Read Blocks"] ?? 0, tempWritten: node["Temp Written Blocks"] ?? 0 }
  }, ...(node.Plans ?? []).flatMap((child, index) => summarizeNodes(child, `${path}.${index}`))];
};
const summarizeThree = (values: readonly number[]) => {
  assert.equal(values.length, 3);
  const sorted = [...values].sort((left, right) => left - right);
  return { count: 3, min: sorted[0]!, median: sorted[1]!, max: sorted[2]!, mean: values.reduce((sum, value) => sum + value, 0) / 3 };
};

/** These parents deliberately contain non-domain payload {}. Only SQL query
 * diagnostics use them; they must never enter the receiver or dispatcher. */
const seedFixture = async (client: postgres.Sql, fixture: Fixture): Promise<void> => {
  await client.begin(async tx => {
    // This connection belongs to withPerformanceDatabase's disposable DB.
    // One parent at a time avoids confusing other parents' heap positions with
    // a longer delivered prefix when the planner chooses a sequential scan.
    await tx`TRUNCATE TABLE discord_notification_parts`;
    await tx`DELETE FROM discord_notifications`;
    await tx`INSERT INTO discord_notifications
      (id, family, kind, dedupe_key, payload, payload_hash, part_count, renderer_version)
      VALUES (${fixture.id}, 'result', 'analysis_completed', ${fixture.id}, '{}'::jsonb,
        repeat('0', 64), ${fixture.partCount}, 1)`;
    await tx`INSERT INTO discord_notification_parts
      (notification_id, part_no, status, attempt_count, send_started_at, delivered_at, delivered_message_id)
      SELECT ${fixture.id}, n, CASE WHEN n < ${fixture.frontier} THEN 'DELIVERED' ELSE 'PENDING' END,
        CASE WHEN n < ${fixture.frontier} THEN 1 ELSE 0 END,
        CASE WHEN n < ${fixture.frontier} THEN now() END, CASE WHEN n < ${fixture.frontier} THEN now() END,
        CASE WHEN n < ${fixture.frontier} THEN 'explain-' || n END
      FROM generate_series(0, ${fixture.partCount - 1}) AS n`;
  });
  const rows = await client<{ notification_id: string; count: number; delivered: number; pending: number }[]>`
    SELECT notification_id, count(*)::integer AS count,
      (count(*) FILTER (WHERE status = 'DELIVERED'))::integer AS delivered,
      (count(*) FILTER (WHERE status = 'PENDING'))::integer AS pending
    FROM discord_notification_parts GROUP BY notification_id`;
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.notification_id, fixture.id);
  assert.equal(row.count, fixture.partCount);
  assert.equal(row.delivered, fixture.frontier);
  assert.equal(row.pending, fixture.partCount - fixture.frontier);
  await client`ANALYZE discord_notification_parts`;
};

const capture = async (client: postgres.Sql, fixture: Fixture, operation: Operation, directory: string) => {
  const expectedRows = operation === "complete" && fixture.frontier < fixture.partCount - 1 ? 1 : 0;
  const samples = [];
  for (let repetition = 0; repetition < 4; repetition += 1) {
    const rows = await client.unsafe<{ "QUERY PLAN": unknown }[]>(
      `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) ${statements[operation]}`, parameters(fixture, operation));
    assert.equal(rows.length, 1);
    const rawPlan = rows[0]!["QUERY PLAN"];
    const document = planSchema.parse(rawPlan)[0]!;
    const nodes = summarizeNodes(document.Plan);
    const root = nodes[0]!;
    assert.equal(root.actualLoops, 1);
    assert.equal(root.actualRowsPerLoop, expectedRows);
    samples.push({ repetition, warmup: repetition === 0, rawPlan, planningMs: document["Planning Time"],
      executionMs: document["Execution Time"], rootBuffers: root.buffers, nodes });
  }
  // Validate the actual result after recording, without an extra pre-timing
  // query. LIMIT without ORDER BY may return any unfinished later part.
  const selected = await client.unsafe<{ part_no: number }[]>(statements[operation], parameters(fixture, operation));
  assert.equal(selected.length, expectedRows);
  if (selected[0]) { assert.ok(selected[0].part_no > fixture.frontier && selected[0].part_no < fixture.partCount); }
  const artifact = `parts-${fixture.partCount}-${fixture.position}-${operation}.json`;
  await writePerformanceArtifact(directory, artifact, { schemaVersion: 1, fixture, operation, statement: statements[operation],
    parameters: parameters(fixture, operation), expectedRows, samples, verification: { passed: true } });
  const adopted = samples.filter(sample => !sample.warmup);
  return { fixture, operation, artifact, expectedRows,
    executionMs: summarizeThree(adopted.map(sample => sample.executionMs)),
    planningMs: summarizeThree(adopted.map(sample => sample.planningMs)),
    // Parent buffers already include children. Summing node counters would double count.
    rootSharedHitBlocks: summarizeThree(adopted.map(sample => sample.rootBuffers.sharedHit)),
    rootSharedReadBlocks: summarizeThree(adopted.map(sample => sample.rootBuffers.sharedRead)),
    scans: adopted.map(sample => ({ repetition: sample.repetition,
      nodes: sample.nodes.filter(node => node.relation === "discord_notification_parts") })) };
};

const references = ["https://www.postgresql.org/docs/18/sql-explain.html", "https://www.postgresql.org/docs/18/using-explain.html"];
const methodology = {
  scope: "Two SELECTs from begin/complete only; not the full port commands or total delivery time",
  fixture: "Synthetic SQL-only parents with non-domain payload {}; no receiver, dispatcher or Discord is started",
  progress: "Static delivered prefixes with one additional UPDATE before complete; not a replay of delivery updates or autovacuum history",
  sampling: "One warmup plus three adopted executions per query; no p95/p99 interpretation",
  timing: "TIMING OFF removes per-node clock reads; total statement Execution Time is still measured and instrumentation remains",
  buffers: "Root counters include child nodes and repeated buffer accesses; counters are not distinct pages and are not summed across nodes",
  rowCounts: "Node actual rows and removed rows are averages per loop; multiply by Actual Loops to estimate totals",
  limits: "Server EXPLAIN timing excludes client network and, without SERIALIZE, output conversion; no advisory lock contention or transaction round trips are measured",
  cache: "Fixtures and ANALYZE warm the cache; no cold-cache claim, planner forcing, index changes or concurrent workload",
  statistics: "Each case recreates parts for one parent and runs ANALYZE in the owned disposable DB; unrelated parents do not affect scan length",
  references
};

let output: string | undefined;
let current: { fixture: Fixture; operation: Operation } | undefined;
const diagnose = async (): Promise<void> => {
  const [flag, path, ...extra] = process.argv.slice(2);
  if (flag !== "--output" || !path || path.startsWith("--") || path.includes("\0") || extra.length > 0) {
    throw new CapacityError("setup_or_measurement", "arguments");
  }
  const directory = resolve(path);
  const adminUrl = requireLocalTestUrl(process.env["TEST_DATABASE_URL"]).href;
  await performanceStage("output_directory", () => createPerformanceOutput(directory));
  output = directory;
  const sourceHashes = Object.fromEntries(await Promise.all([
    "src/db/repositories/notifications.delivery.ts", "scripts/perf/notificationPerformance.explain.ts",
    "scripts/perf/notificationPerformance.storage.ts", "../momo-db/src/schema.ts", "pnpm-lock.yaml"
  ].map(async name => [name, createHash("sha256").update(await readFile(new URL(name, performanceRoot))).digest("hex")] as const)));
  const results = await performanceStage("database_diagnostic", () => withPerformanceDatabase(adminUrl, async ({ client, version }) => {
    const settings = await client<{ name: string; setting: string; unit: string | null }[]>`
      SELECT name, setting, unit FROM pg_settings WHERE name IN
        ('server_version_num', 'block_size', 'shared_buffers', 'work_mem', 'effective_cache_size',
          'seq_page_cost', 'random_page_cost', 'cpu_tuple_cost', 'jit', 'max_parallel_workers_per_gather', 'track_io_timing')
      ORDER BY name`;
    const indexes = await client<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'discord_notification_parts' ORDER BY indexname`;
    assert.ok(indexes.some(index => index.indexname === "discord_notification_parts_pk"));
    await writePerformanceArtifact(directory, "manifest.json", { schemaVersion: 1, startedAt: new Date().toISOString(),
      postgresVersion: version, hostRuntime: { node: process.version, platform: process.platform, arch: process.arch },
      sourceHashes, settings, indexes, fixtures, methodology });
    const summaries = [];
    for (const fixture of fixtures) {
      current = { fixture, operation: "begin" };
      await performanceStage("fixture_setup", () => seedFixture(client, fixture));
      summaries.push(await capture(client, fixture, "begin", directory));
      const changed = await client`UPDATE discord_notification_parts SET status = 'DELIVERED', attempt_count = 1,
        send_started_at = now(), delivered_at = now(), delivered_message_id = 'explain-current'
        WHERE notification_id = ${fixture.id} AND part_no = ${fixture.frontier} AND status = 'PENDING' RETURNING part_no`;
      assert.equal(changed.length, 1);
      current = { fixture, operation: "complete" };
      summaries.push(await capture(client, fixture, "complete", directory));
    }
    return summaries;
  }));
  assert.equal(results.length, 12);
  await writePerformanceArtifact(directory, "summary.json", { schemaVersion: 1, completedAt: new Date().toISOString(),
    methodology, results, verification: { passed: true, ownedDatabaseCleanedUp: true } });
  console.log("Notification part query diagnostic completed: 12 cases, 36 adopted plans.");
};

await diagnose().catch(async (error: unknown) => {
  const stage = error instanceof CapacityError ? error.detail ?? "configuration_or_setup" : "configuration_or_setup";
  process.exitCode = 1;
  if (output) {
    await writePerformanceArtifact(output, "failure.json", { schemaVersion: 1, code: "setup_or_measurement", stage, current: current ?? null })
      .catch(() => { process.stderr.write("Query diagnostic failure artifact could not be written.\n"); });
  }
  // Driver failures can contain URLs or bound SQL. Keep the public error fixed.
  process.stderr.write(`Notification part query diagnostic failed (${stage}).\n`);
});
