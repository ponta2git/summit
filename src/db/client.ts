import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { env } from "../env.js";
import * as schema from "./schema.js";

// why: connect_timeout:10 は接続不良時のハングを抑え、idle_timeout:60 / max_lifetime:1800 で stale 接続を定期更新する。
// why: max:5 は単一インスタンス + cron tick + interaction 並走上限に十分で、pooler への過剰接続を避ける。
// invariant: Neon の PgBouncer (transaction pooling) では prepared statement を共有できないため prepare:false は必須。
// source-of-truth: アプリ DB 接続は DATABASE_URL (pooled) のみを使う。DIRECT_URL は drizzle.config.ts 専用。
// @see docs/adr/0003-postgres-drizzle-operations.md
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
