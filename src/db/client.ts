import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { env } from "../env.js";
import * as schema from "./schema.js";

/**
 * Production postgres.js client for the Drizzle DB handle.
 *
 * @remarks
 * invariant: Neon の PgBouncer (transaction pooling) は prepared statement を共有できないため
 *   `prepare: false` 必須。外す / 上書きしない。
 * source-of-truth: アプリは `DATABASE_URL` (pooled) のみ。`DIRECT_URL` は momo-db の drizzle.config.ts 専用。
 * why: `connect_timeout` は接続不良時のハングを抑え、`idle_timeout` / `max_lifetime` で stale
 *   接続を定期更新。`max` は単一インスタンス + cron + interaction の並走上限に十分で pooler への
 *   過剰接続を避ける閾値。
 * @see ADR-0003
 */
const client = postgres(env.DATABASE_URL, {
  connect_timeout: 10,
  idle_timeout: 60,
  max: 5,
  max_lifetime: 60 * 30,
  prepare: false,
  connection: { application_name: "summit-bot" },
});

export const db = drizzle(client, { schema, casing: "snake_case" });

export const closeDb = async (): Promise<void> => {
  await client.end({ timeout: 5 });
};
