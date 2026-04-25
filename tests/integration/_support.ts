import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "../../src/db/schema.js";

// invariant: integration test 共通の DB setup。各 suite 専用に接続を張り、afterAll で閉じる。
//   INTEGRATION_DB=1 gate と LOCAL_HOSTS allowlist は呼び出し側で済ませる前提。
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "postgres"]);

export const isIntegration = process.env["INTEGRATION_DB"] === "1";

export interface IntegrationDb {
  readonly db: ReturnType<typeof drizzle<typeof schema>>;
  readonly client: postgres.Sql;
}

export const createIntegrationDb = (): IntegrationDb => {
  const url = process.env["DATABASE_URL"] ?? "";
  // secret: 本番誤爆防止。localhost / docker compose 内 hostname のみ許可。
  if (url && !LOCAL_HOSTS.has(new URL(url).hostname)) {
    throw new Error(
      `Refusing integration test on non-local DATABASE_URL host: ${new URL(url).hostname}`
    );
  }
  // tx: src/db/client.ts の singleton は流用しない。close 競合・並列時の脆さを避ける。
  //   invariant: single worker (vitest.integration.config.ts) 前提。max: 1 で十分。
  const client = postgres(url, { prepare: false, max: 1 });
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
  await db.execute(sql`SELECT 1 FROM discord_outbox LIMIT 0`);
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
    ON CONFLICT (id) DO NOTHING
  `);
};

/**
 * Truncate all per-test tables. `members` は fixture として保持する。
 * `held_event_participants` → `held_events` → `responses` → `discord_outbox` → `sessions` の順で
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
      discord_outbox,
      sessions
    RESTART IDENTITY CASCADE
  `);
};
