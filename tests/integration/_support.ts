import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "../../src/db/schema.js";

import { requireLocalTestUrl } from "./databaseLifecycle.ts";

const clients = new Set<postgres.Sql>();
export const closeIntegrationDbs = async (): Promise<void> => {
  await Promise.all([...clients].map(client => client.end({ timeout: 5 })));
  clients.clear();
};

export const isIntegration = process.env["INTEGRATION_DB"] === "1";

export interface IntegrationDb {
  readonly db: ReturnType<typeof drizzle<typeof schema>>;
  readonly client: postgres.Sql;
}

export const createIntegrationDb = (options: { readonly maxConnections?: number } = {}): IntegrationDb => {
  const url = requireLocalTestUrl(process.env["DATABASE_URL"]);
  if (!isIntegration || !/^\/summit_test_[a-f0-9]{32}_[a-f0-9]{12}$/.test(url.pathname)) {
    throw new Error("Integration clients require a file-owned disposable database");
  }
  const client = postgres(url.href, { prepare: false, max: options.maxConnections ?? 1, onnotice: () => undefined });
  clients.add(client);
  const db = drizzle(client, { schema, casing: "snake_case" });
  return { db, client };
};

/**
 * Assert that migrations have been applied by probing required tables.
 * Fail-fast if schema is missing so integration tests don't silently "pass".
 */
export const assertSchemaReady = async (
  db: ReturnType<typeof drizzle<typeof schema>>
): Promise<void> => {
  await db.execute(sql`SELECT 1 FROM sessions LIMIT 0`);
  await db.execute(sql`SELECT 1 FROM members LIMIT 0`);
  await db.execute(sql`SELECT 1 FROM responses LIMIT 0`);
  await db.execute(sql`SELECT 1 FROM discord_notifications LIMIT 0`);
  await db.execute(sql`SELECT 1 FROM held_events LIMIT 0`);
  await db.execute(sql`SELECT 1 FROM held_event_participants LIMIT 0`);
};

/**
 * Seed the canonical 4-member fixture used across contract tests.
 * Idempotent via ON CONFLICT DO NOTHING so suites can call in beforeAll.
 */
export const seedBaseMembers = async (
  db: ReturnType<typeof drizzle<typeof schema>>
): Promise<void> => {
  await db.execute(sql`
    INSERT INTO members (id, user_id, display_name) VALUES
      ('m1','333333333333333333','Member1'),
      ('m2','444444444444444444','Member2'),
      ('m3','555555555555555555','Member3'),
      ('m4','666666666666666666','Member4')
    ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id, display_name = EXCLUDED.display_name
  `);
};

/**
 * Truncate all per-test tables. `members` は fixture として保持する。
 * `held_event_participants` → `held_events` → `responses` → `discord_notifications` → `sessions` の順で
 * 依存関係を考慮するが `CASCADE` で一括対処する。
 */
export const truncatePerTestTables = async (
  db: ReturnType<typeof drizzle<typeof schema>>
): Promise<void> => {
  await db.execute(sql`
    TRUNCATE TABLE
      held_event_participants,
      held_events,
      responses,
      discord_notifications,
      sessions
    RESTART IDENTITY CASCADE
  `);
};
