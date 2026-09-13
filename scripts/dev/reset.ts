// why: 開発中の挙動確認で sessions / responses を空にしてやり直したいケースが頻出する。
//   手で docker exec して TRUNCATE するのは事故の温床になるため、localhost 限定のガード付き
//   スクリプトとして集約する。本番 (Neon) の DATABASE_URL では絶対に動かない。
// @see docs/dev-rule.md
// @see README.md 開発フロー
process.env["TZ"] = "Asia/Tokyo";

import { sql } from "drizzle-orm";

import { closeDb, db } from "../../src/db/client.ts";
import { env } from "../../src/env.ts";
import { logger } from "../../src/logger.ts";

import { assertLocalDatabase } from "./localDatabase.ts";

const parseFlags = (argv: readonly string[]): { includeMembers: boolean } => {
  const includeMembers = argv.includes("--all") || argv.includes("--members");
  return { includeMembers };
};

const run = async (): Promise<void> => {
  assertLocalDatabase(env.DATABASE_URL);

  const { includeMembers } = parseFlags(process.argv.slice(2));

  // why: ローカル開発を初期状態へ戻す。共有通知の dedupe も消して同じ週をやり直せる。
  //   members は user config の members で seed 済み前提のため既定では残す。
  // idempotent: TRUNCATE は冪等。複数回実行しても結果は同じ。
  await db.execute(
    sql`TRUNCATE TABLE discord_notifications, responses, held_event_participants, held_events, sessions RESTART IDENTITY CASCADE`
  );

  if (includeMembers) {
    await db.execute(sql`TRUNCATE TABLE members RESTART IDENTITY CASCADE`);
  }

  const baseTables = ["discord_notifications", "responses", "held_event_participants", "held_events", "sessions"];
  logger.warn(
    {
      host: new URL(env.DATABASE_URL).hostname,
      tablesTruncated: includeMembers ? [...baseTables, "members"] : baseTables,
      includeMembers
    },
    "Dev database reset: session-related tables truncated."
  );
};

void run()
  .catch((error: unknown) => {
    logger.error({ error }, "Dev reset failed.");
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
