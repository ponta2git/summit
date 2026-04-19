import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { env } from "../env.js";
import * as schema from "./schema.js";

// why: Neon の PgBouncer (transaction pooling) は prepared statement を共有できないため prepare:false が必須。
// invariant: 単一インスタンス前提。max:5 は cron tick + interaction 同時押下の並走上限として十分。
// source-of-truth: アプリ DB 接続は DATABASE_URL (pooled) のみを使う。DIRECT_URL は drizzle.config.ts 専用。
// @see docs/adr/0003-postgres-drizzle-operations.md
const client = postgres(env.DATABASE_URL, { max: 5, prepare: false });

export const db = drizzle(client, { schema, casing: "snake_case" });

export const closeDb = async (): Promise<void> => {
  await client.end({ timeout: 5 });
};
