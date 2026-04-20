// why: 開発中の実 Discord + ローカル Postgres 手動テスト用 CLI。本番 DB では一切動作しない。
//   業務仕様の週次 cron (金 21:30 / 土 00:00) を待たず、DB を直接操作して締切を巻き戻し、
//   bot 再起動時の startup recovery 経由で settle を発火させる。
// invariant: localhost 限定ガードを reset.ts と同じロジックで適用する。
// @see AGENTS.md "開発中の DB 操作 (ローカル限定)"
// @see scripts/dev/reset.ts
process.env.TZ = "Asia/Tokyo";

import { and, desc, eq, inArray } from "drizzle-orm";

import { closeDb, db } from "../../src/db/client.js";
import { responses, sessions } from "../../src/db/schema.js";
import { env } from "../../src/env.js";
import { logger } from "../../src/logger.js";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "postgres"]);

const assertLocalDatabase = (url: string): void => {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`DATABASE_URL is not parseable as URL: ${url}`);
  }
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      `Refusing to run: DATABASE_URL host "${host}" is not localhost. ` +
        `This script is for dev only. Expected one of: ${[...LOCAL_HOSTS].join(", ")}.`
    );
  }
};

// state: 進行中 = 終端状態 (COMPLETED / CANCELLED / SKIPPED / POSTPONED / DECIDED) 以外
const ACTIVE_STATUSES = ["ASKING", "POSTPONE_VOTING"] as const;

const findActiveSession = async () => {
  const rows = await db
    .select()
    .from(sessions)
    .where(inArray(sessions.status, [...ACTIVE_STATUSES]))
    .orderBy(desc(sessions.createdAt))
    .limit(1);
  return rows[0];
};

const cmdStatus = async (): Promise<void> => {
  const all = await db.select().from(sessions).orderBy(desc(sessions.createdAt)).limit(10);
  if (all.length === 0) {
    console.log("(no sessions)");
    return;
  }
  for (const s of all) {
    const rs = await db
      .select()
      .from(responses)
      .where(eq(responses.sessionId, s.id));
    console.log(
      `${s.createdAt.toISOString()}  ${s.status.padEnd(16)} ` +
        `week=${s.weekKey} postponeCount=${s.postponeCount} ` +
        `candidate=${s.candidateDateIso} deadline=${s.deadlineAt.toISOString()} ` +
        `id=${s.id}`
    );
    if (s.cancelReason) {
      console.log(`    cancelReason: ${s.cancelReason}`);
    }
    if (s.decidedStartAt) {
      console.log(`    decidedStartAt: ${s.decidedStartAt.toISOString()}`);
    }
    for (const r of rs) {
      console.log(`    - member=${r.memberId} choice=${r.choice}`);
    }
  }
};

const cmdShorten = async (seconds: number): Promise<void> => {
  const active = await findActiveSession();
  if (!active) {
    console.log("No active (ASKING / POSTPONE_VOTING) session found.");
    return;
  }
  const newDeadline = new Date(Date.now() + seconds * 1000);
  await db
    .update(sessions)
    .set({ deadlineAt: newDeadline, updatedAt: new Date() })
    .where(and(eq(sessions.id, active.id), eq(sessions.status, active.status)));
  console.log(
    `Shortened deadline of session ${active.id} (status=${active.status}) ` +
      `to ${newDeadline.toISOString()} (+${seconds}s).`
  );
  console.log(
    "Next step: restart `pnpm dev` — startup recovery will settle it once deadline passes."
  );
};

const cmdExpire = async (): Promise<void> => {
  const active = await findActiveSession();
  if (!active) {
    console.log("No active session found.");
    return;
  }
  const past = new Date(Date.now() - 60_000);
  await db
    .update(sessions)
    .set({ deadlineAt: past, updatedAt: new Date() })
    .where(and(eq(sessions.id, active.id), eq(sessions.status, active.status)));
  console.log(
    `Expired session ${active.id} (status=${active.status}) — deadlineAt set to ${past.toISOString()}.`
  );
  console.log("Next step: restart `pnpm dev` to trigger startup recovery.");
};

const usage = (): void => {
  console.log(`Usage: pnpm dev:scenario <command> [args]

Commands:
  status                   Print up to 10 recent sessions and their responses
  shorten [seconds=10]     Set the active session's deadlineAt to now + seconds
  expire                   Set the active session's deadlineAt to the past (60s ago)

Workflow:
  1. pnpm db:reset            (clear sessions / responses, keep members)
  2. pnpm dev                 (start bot)
  3. /ask in Discord          (create Friday ASKING session)
  4. Click buttons with your real members (1 ABSENT to trigger postpone flow)
  5. pnpm dev:scenario expire (force deadline past)
  6. Ctrl-C + pnpm dev        (startup recovery settles → POSTPONE_VOTING)
  7. Click postpone OK/NG in Discord
  8. pnpm dev:scenario expire + restart (settle → POSTPONED + Saturday ASKING sent)
  9. Click Saturday buttons, repeat expire + restart to finish.
`);
};

const run = async (): Promise<void> => {
  assertLocalDatabase(env.DATABASE_URL);
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "status":
      await cmdStatus();
      return;
    case "shorten": {
      const seconds = Number(rest[0] ?? "10");
      if (!Number.isFinite(seconds) || seconds < 0) {
        throw new Error("seconds must be a non-negative number");
      }
      await cmdShorten(seconds);
      return;
    }
    case "expire":
      await cmdExpire();
      return;
    case undefined:
    case "help":
    case "-h":
    case "--help":
      usage();
      return;
    default:
      usage();
      process.exitCode = 1;
  }
};

void run()
  .catch((error: unknown) => {
    logger.error({ error }, "Dev scenario failed.");
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
