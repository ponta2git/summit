// why: 開発中の挙動確認で sessions / responses を空にしてやり直したいケースが頻出する。
//   手で docker exec して TRUNCATE するのは事故の温床になるため、localhost 限定のガード付き
//   スクリプトとして集約する。本番 (Neon) の DATABASE_URL では絶対に動かない。
// @see AGENTS.md "本番 DB 破壊禁止"
// @see README.md 開発フロー
process.env.TZ = "Asia/Tokyo";

import { sql } from "drizzle-orm";

import { closeDb, db } from "../../src/db/client.js";
import { env } from "../../src/env.js";
import { logger } from "../../src/logger.js";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "postgres"]);

// invariant: DATABASE_URL が localhost を指していないときは破壊的 TRUNCATE を絶対に実行しない。
//   Neon / Fly の secret を誤って .env.local に入れた状態でも、ここで止める。
const assertLocalDatabase = (url: string): void => {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`DATABASE_URL is not parseable as URL: ${url}`);
  }
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      `Refusing to reset: DATABASE_URL host "${host}" is not localhost. ` +
        `This script is for dev only. Expected one of: ${[...LOCAL_HOSTS].join(", ")}.`
    );
  }
};

const parseFlags = (argv: readonly string[]): { includeMembers: boolean } => {
  const includeMembers = argv.includes("--all") || argv.includes("--members");
  return { includeMembers };
};

const run = async (): Promise<void> => {
  assertLocalDatabase(env.DATABASE_URL);

  const { includeMembers } = parseFlags(process.argv.slice(2));

  // why: responses / held_event_participants / held_events / sessions を消す。
  //   FK 順序は CASCADE で吸収される (sessions→held_events→participants は cascade delete)。
  //   members は env.MEMBER_USER_IDS で seed 済み前提のため既定では残す。
  // idempotent: TRUNCATE は冪等。複数回実行しても結果は同じ。
  // @see ADR-0031 HeldEvent 永続化
  await db.execute(
    sql`TRUNCATE TABLE responses, held_event_participants, held_events, sessions RESTART IDENTITY CASCADE`
  );

  if (includeMembers) {
    await db.execute(sql`TRUNCATE TABLE members RESTART IDENTITY CASCADE`);
  }

  const baseTables = ["responses", "held_event_participants", "held_events", "sessions"];
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
