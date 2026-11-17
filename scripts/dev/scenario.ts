import { runLocalCommand } from "./runLocalCommand.ts";
// why: 開発中の実 Discord + ローカル Postgres 手動テスト用 CLI。本番 DB では一切動作しない。
//   業務仕様の週次 cron (金 21:30 / 土 00:00) を待たず、DB を直接操作して締切を巻き戻し、
//   bot 再起動時の startup recovery 経由で settle を発火させる。
// invariant: localhost 限定ガードを reset.ts と同じロジックで適用する。
// @see docs/dev-rule.md
// @see scripts/dev/reset.ts
process.env["TZ"] = "Asia/Tokyo";

import { and, desc, eq, inArray } from "drizzle-orm";

import { closeDb, db } from "../../src/db/client.ts";
import { responses, sessions } from "../../src/db/schema.ts";
import { identityLayout, nativeId, wireId } from "../../src/db/identities.ts";
import { responseColumns, sessionColumns } from "../../src/db/identityColumns.ts";
import { env } from "../../src/env.ts";
import { logger } from "../../src/logger.ts";

import { assertLocalDatabase } from "./localDatabase.ts";

// state: 進行中 = 終端状態 (COMPLETED / CANCELLED / SKIPPED / POSTPONED / DECIDED) 以外
const ACTIVE_STATUSES = ["ASKING", "POSTPONE_VOTING"] as const;

const findActiveSession = async () => {
  const rows = await db
    .select(sessionColumns(await identityLayout(db)))
    .from(sessions)
    .where(inArray(sessions.status, [...ACTIVE_STATUSES]))
    .orderBy(desc(sessions.createdAt))
    .limit(1);
  return rows[0];
};

const cmdStatus = async (): Promise<void> => {
  const all = await db.select(sessionColumns(await identityLayout(db))).from(sessions).orderBy(desc(sessions.createdAt)).limit(10);
  if (all.length === 0) {
    console.log("(no sessions)");
    return;
  }
  for (const session of all) {
    const sessionResponses = await db
      .select(responseColumns(await identityLayout(db)))
      .from(responses)
      .where(eq(responses.sessionId, nativeId(await identityLayout(db), sessions, session.id)));
    console.log(
      `${session.createdAt.toISOString()}  ${session.status.padEnd(16)} ` +
        `week=${session.weekKey} postponeCount=${session.postponeCount} ` +
        `candidate=${session.candidateDateIso} deadline=${session.deadlineAt.toISOString()} ` +
        `id=${session.id}`
    );
    if (session.cancelReason) {
      console.log(`    cancelReason: ${session.cancelReason}`);
    }
    if (session.decidedStartAt) {
      console.log(`    decidedStartAt: ${session.decidedStartAt.toISOString()}`);
    }
    for (const response of sessionResponses) {
      console.log(`    - member=${response.memberId} choice=${response.choice}`);
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
    .where(and(eq(wireId(await identityLayout(db), sessions), active.id), eq(sessions.status, active.status)));
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
    .where(and(eq(wireId(await identityLayout(db), sessions), active.id), eq(sessions.status, active.status)));
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

await runLocalCommand(run, closeDb, error => {
  process.exitCode = 1;
  logger.error({ error }, "Dev scenario failed.");
});
