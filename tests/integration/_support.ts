import { fixtureMember } from "./canonicalFixture.ts";
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
 * Seed the canonical 4-member fixture used across contract tests.
 * Idempotent via ON CONFLICT DO NOTHING so suites can call in beforeAll.
 */
export const seedBaseMembers = async (
  db: ReturnType<typeof drizzle<typeof schema>>
): Promise<void> => {
  await db.insert(schema.members).values([
    { id: "m1", userId: "333333333333333333", displayName: "Member1" },
    { id: "m2", userId: "444444444444444444", displayName: "Member2" },
    { id: "m3", userId: "555555555555555555", displayName: "Member3" },
    { id: "m4", userId: "666666666666666666", displayName: "Member4" }
  ].map(fixtureMember)).onConflictDoNothing();
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
