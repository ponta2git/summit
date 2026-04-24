import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as schema from "../../src/db/schema.js";
import {
  cancelAsking,
  claimReminderDispatch,
  completeCancelledSession,
  completePostponeVoting,
  createAskSession,
  decideAsking,
  findSessionByWeekKeyAndPostponeCount,
  revertReminderClaim,
  startPostponeVoting
} from "../../src/db/repositories/sessions.js";
import {
  listResponses,
  upsertResponse
} from "../../src/db/repositories/responses.js";

// invariant: INTEGRATION_DB=1 のときだけ実行する。gate は vitest.integration.config.ts の
//   include 側と二重化することで、誤って `pnpm test` に拾われても no-op にする。
// @see docs/adr/0003-postgres-drizzle-operations.md
const isIntegration = process.env.INTEGRATION_DB === "1";
const describeDb = isIntegration ? describe : describe.skip;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "postgres"]);

describeDb("sessions repository contract (integration)", () => {
  const url = process.env.DATABASE_URL ?? "";
  // secret: 本番誤爆防止。localhost / docker compose 内 hostname のみ許可。
  //   本番の DATABASE_URL を誤って export して実行しても fail-fast で拒否する。
  if (url && !LOCAL_HOSTS.has(new URL(url).hostname)) {
    throw new Error(
      `Refusing integration test on non-local DATABASE_URL host: ${new URL(url).hostname}`
    );
  }

  // tx: src/db/client.ts の singleton は流用しない。close 競合・並列時の脆さを避けるため
  //   このスイート専用の接続を開き、afterAll で確実に閉じる。
  //   invariant: single worker (vitest.integration.config.ts) 前提。max: 1 で十分。
  const client = postgres(url, { prepare: false, max: 1 });
  const db = drizzle(client, { schema, casing: "snake_case" });

  beforeAll(async () => {
    // invariant: migrate 済みのスキーマが存在することを fail-fast で検査する。
    await db.execute(sql`SELECT 1 FROM sessions LIMIT 0`);
    await db.execute(sql`SELECT 1 FROM members LIMIT 0`);
    await db.execute(sql`SELECT 1 FROM responses LIMIT 0`);

    // why: beforeEach の TRUNCATE は members を残すため、seed は一度だけ挿入する。
    await db.execute(sql`
      INSERT INTO members (id, user_id, display_name) VALUES
        ('m1','333333333333333333','Member1'),
        ('m2','444444444444444444','Member2'),
        ('m3','555555555555555555','Member3'),
        ('m4','666666666666666666','Member4')
      ON CONFLICT (id) DO NOTHING
    `);
  });

  beforeEach(async () => {
    // idempotent: responses → sessions の順で TRUNCATE CASCADE。members は保持する。
    //   RESTART IDENTITY は将来 serial 列を追加したとき用の保険。
    await db.execute(sql`TRUNCATE TABLE responses, sessions RESTART IDENTITY CASCADE`);
  });

  afterAll(async () => {
    await client.end({ timeout: 5 });
  });

  const baseSession = {
    weekKey: "2026-W17",
    postponeCount: 0,
    candidateDateIso: "2026-04-24",
    channelId: "channel-1",
    deadlineAt: new Date("2026-04-24T12:30:00.000Z")
  };

  // unique: (weekKey, postponeCount) unique 制約 + onConflictDoNothing。
  // race: 2 回目の同一 (weekKey, postponeCount) で undefined が返ることを DB レベルで確認する。
  it("createAskSession: second insert for same (weekKey, postponeCount) returns undefined (race-safe)", async () => {
    const first = await createAskSession(db, { id: "s1", ...baseSession });
    expect(first?.id).toBe("s1");

    const second = await createAskSession(db, { id: "s2", ...baseSession });
    expect(second).toBeUndefined();

    const found = await findSessionByWeekKeyAndPostponeCount(db, baseSession.weekKey, 0);
    expect(found?.id).toBe("s1");
  });

  // race: CAS が成功するケース。WHERE status='ASKING' に一致すれば UPDATE 成功し、新状態を返す。
  it("cancelAsking(ASKING→CANCELLED): succeeds when current status matches", async () => {
    await createAskSession(db, { id: "s1", ...baseSession });
    const updated = await cancelAsking(db, {
      id: "s1",
      now: new Date("2026-04-24T12:31:00.000Z"),
      reason: "deadline_unanswered"
    });
    expect(updated?.status).toBe("CANCELLED");
    expect(updated?.cancelReason).toBe("deadline_unanswered");
  });

  // race: CAS が失敗するケース。既に CANCELLED の session に再度 ASKING→CANCELLED をかけると undefined。
  // invariant: 呼び出し側はこれを観測しても state を巻き戻さず、DB 再取得して続行する。
  it("cancelAsking: returns undefined when current status mismatches (race lost)", async () => {
    await createAskSession(db, { id: "s1", ...baseSession });
    const first = await cancelAsking(db, {
      id: "s1",
      now: new Date("2026-04-24T12:31:00.000Z"),
      reason: "deadline_unanswered"
    });
    expect(first?.status).toBe("CANCELLED");

    const second = await cancelAsking(db, {
      id: "s1",
      now: new Date("2026-04-24T12:32:00.000Z"),
      reason: "deadline_unanswered"
    });
    expect(second).toBeUndefined();
  });

  it("startPostponeVoting(CANCELLED→POSTPONE_VOTING): updates deadlineAt on CAS win", async () => {
    await createAskSession(db, { id: "s1", ...baseSession });
    await cancelAsking(db, {
      id: "s1",
      now: new Date("2026-04-24T12:31:00.000Z"),
      reason: "deadline_unanswered"
    });
    const updated = await startPostponeVoting(db, {
      id: "s1",
      now: new Date("2026-04-24T12:32:00.000Z"),
      postponeDeadlineAt: new Date("2026-04-24T15:00:00.000Z")
    });
    expect(updated?.status).toBe("POSTPONE_VOTING");
    expect(updated?.deadlineAt.toISOString()).toBe("2026-04-24T15:00:00.000Z");
  });

  it("completePostponeVoting(POSTPONE_VOTING→COMPLETED): stores cancel reason", async () => {
    await createAskSession(db, { id: "s1", ...baseSession });
    await cancelAsking(db, {
      id: "s1",
      now: new Date("2026-04-24T12:31:00.000Z"),
      reason: "deadline_unanswered"
    });
    await startPostponeVoting(db, {
      id: "s1",
      now: new Date("2026-04-24T12:32:00.000Z"),
      postponeDeadlineAt: new Date("2026-04-24T15:00:00.000Z")
    });
    const completed = await completePostponeVoting(db, {
      id: "s1",
      now: new Date("2026-04-24T15:00:01.000Z"),
      outcome: "cancelled_full",
      cancelReason: "postpone_unanswered"
    });
    expect(completed?.status).toBe("COMPLETED");
    expect(completed?.cancelReason).toBe("postpone_unanswered");
  });

  it("decideAsking(ASKING→DECIDED): sets decidedStartAt and reminderAt", async () => {
    await createAskSession(db, { id: "s1", ...baseSession });
    const decided = await decideAsking(db, {
      id: "s1",
      now: new Date("2026-04-24T12:31:00.000Z"),
      decidedStartAt: new Date("2026-04-24T14:00:00.000Z"),
      reminderAt: new Date("2026-04-24T13:45:00.000Z")
    });
    expect(decided?.status).toBe("DECIDED");
    expect(decided?.decidedStartAt?.toISOString()).toBe("2026-04-24T14:00:00.000Z");
    expect(decided?.reminderAt?.toISOString()).toBe("2026-04-24T13:45:00.000Z");
  });

  // unique: (sessionId, memberId) unique + onConflictDoUpdate。
  //   同一メンバーの押し直しは choice を最新値に上書きし、1 行だけ維持する。
  it("upsertResponse: upserts on (sessionId, memberId) and retains the latest choice", async () => {
    await createAskSession(db, { id: "s1", ...baseSession });

    await upsertResponse(db, {
      id: "r1",
      sessionId: "s1",
      memberId: "m1",
      choice: "T2200",
      answeredAt: new Date("2026-04-24T10:00:00.000Z")
    });
    await upsertResponse(db, {
      id: "r2",
      sessionId: "s1",
      memberId: "m1",
      choice: "T2330",
      answeredAt: new Date("2026-04-24T10:05:00.000Z")
    });

    const rows = await listResponses(db, "s1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.choice).toBe("T2330");
  });

  // race: 並行した cancelAsking (ASKING→CANCELLED) で片方だけが勝つ。もう片方は undefined。
  //   invariant: DB の `UPDATE ... WHERE status='ASKING'` が CAS primitive として機能することを
  //   実 postgres で確認する。Fake ports との契約一致の根拠。
  it("cancelAsking: concurrent CAS on same ASKING session — exactly one wins", async () => {
    await createAskSession(db, { id: "s1", ...baseSession });
    const [a, b] = await Promise.all([
      cancelAsking(db, {
        id: "s1",
        now: new Date("2026-04-24T12:31:00.000Z"),
        reason: "deadline_unanswered"
      }),
      cancelAsking(db, {
        id: "s1",
        now: new Date("2026-04-24T12:31:00.001Z"),
        reason: "deadline_unanswered"
      })
    ]);
    const winners = [a, b].filter((r) => r !== undefined);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.status).toBe("CANCELLED");
  });

  // regression: postponeCount IN (0,1) の DB CHECK 制約がドメイン層より先に弾くことを保証する。
  //   why: drizzle は error message に constraint 名を含めないため、rejection と「行が入っていない」
  //   の 2 つで検証する。
  // @see src/db/schema.ts
  it("DB rejects postponeCount >= 2 via CHECK constraint", async () => {
    let caught: unknown;
    try {
      await db.execute(sql`
        INSERT INTO sessions
          (id, week_key, postpone_count, candidate_date_iso, status, channel_id, deadline_at)
        VALUES
          ('s-bad', '2026-W17', 2, '2026-04-24', 'ASKING', 'c1', now())
      `);
    } catch (err: unknown) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    // why: postgres.js は原因エラーを cause に持たせる。constraint 名で regression を特定する。
    const causeMsg = String(
      (caught as { cause?: { constraint_name?: string; message?: string } }).cause
        ?.constraint_name ??
        (caught as { cause?: { message?: string } }).cause?.message ??
        (caught as Error).message
    );
    expect(causeMsg).toContain("sessions_postpone_count_check");

    const rows = await db.execute(sql`SELECT id FROM sessions WHERE id = 's-bad'`);
    expect(rows).toHaveLength(0);
  });

  // race: 並行した startPostponeVoting (CANCELLED→POSTPONE_VOTING) で片方だけが勝つ。
  //   invariant: deadlineAt は勝った側の値で確定する (UPDATE は 1 件しか成功しないため矛盾しない)。
  it("startPostponeVoting: concurrent CAS on same CANCELLED session — exactly one wins", async () => {
    await createAskSession(db, { id: "s1", ...baseSession });
    await cancelAsking(db, {
      id: "s1",
      now: new Date("2026-04-24T12:31:00.000Z"),
      reason: "deadline_unanswered"
    });

    const [a, b] = await Promise.all([
      startPostponeVoting(db, {
        id: "s1",
        now: new Date("2026-04-24T12:32:00.000Z"),
        postponeDeadlineAt: new Date("2026-04-24T15:00:00.000Z")
      }),
      startPostponeVoting(db, {
        id: "s1",
        now: new Date("2026-04-24T12:32:00.001Z"),
        postponeDeadlineAt: new Date("2026-04-24T15:00:00.000Z")
      })
    ]);
    const winners = [a, b].filter((r) => r !== undefined);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.status).toBe("POSTPONE_VOTING");
  });

  // race: 並行した completePostponeVoting (decided と cancelled_full) — POSTPONE_VOTING への CAS は
  //   先着 1 件のみ勝ち、後着は undefined。負け側の outcome は適用されないことを保証する。
  it("completePostponeVoting: concurrent CAS with conflicting outcomes — first writer wins", async () => {
    await createAskSession(db, { id: "s1", ...baseSession });
    await cancelAsking(db, {
      id: "s1",
      now: new Date("2026-04-24T12:31:00.000Z"),
      reason: "deadline_unanswered"
    });
    await startPostponeVoting(db, {
      id: "s1",
      now: new Date("2026-04-24T12:32:00.000Z"),
      postponeDeadlineAt: new Date("2026-04-24T15:00:00.000Z")
    });

    const [a, b] = await Promise.all([
      completePostponeVoting(db, {
        id: "s1",
        now: new Date("2026-04-24T15:00:01.000Z"),
        outcome: "decided"
      }),
      completePostponeVoting(db, {
        id: "s1",
        now: new Date("2026-04-24T15:00:01.001Z"),
        outcome: "cancelled_full",
        cancelReason: "postpone_unanswered"
      })
    ]);
    const winners = [a, b].filter((r) => r !== undefined);
    expect(winners).toHaveLength(1);
    expect(["POSTPONED", "COMPLETED"]).toContain(winners[0]?.status);
  });

  // race: 並行した decideAsking (ASKING→DECIDED) で片方だけが勝つ。
  //   decidedStartAt は勝者の値で確定し、後着は CAS lost で undefined を返す。
  it("decideAsking: concurrent CAS on same ASKING session — exactly one wins", async () => {
    await createAskSession(db, { id: "s1", ...baseSession });

    const [a, b] = await Promise.all([
      decideAsking(db, {
        id: "s1",
        now: new Date("2026-04-24T12:31:00.000Z"),
        decidedStartAt: new Date("2026-04-24T14:00:00.000Z"),
        reminderAt: new Date("2026-04-24T13:45:00.000Z")
      }),
      decideAsking(db, {
        id: "s1",
        now: new Date("2026-04-24T12:31:00.001Z"),
        decidedStartAt: new Date("2026-04-24T14:30:00.000Z"),
        reminderAt: new Date("2026-04-24T14:15:00.000Z")
      })
    ]);
    const winners = [a, b].filter((r) => r !== undefined);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.status).toBe("DECIDED");
  });

  // race: completeCancelledSession (CANCELLED→COMPLETED) を並行実行しても 1 件だけが勝つ。
  it("completeCancelledSession: concurrent CAS on same CANCELLED session — exactly one wins", async () => {
    await createAskSession(db, { id: "s1", ...baseSession });
    await cancelAsking(db, {
      id: "s1",
      now: new Date("2026-04-24T12:31:00.000Z"),
      reason: "saturday_cancelled"
    });

    const [a, b] = await Promise.all([
      completeCancelledSession(db, {
        id: "s1",
        now: new Date("2026-04-24T12:32:00.000Z")
      }),
      completeCancelledSession(db, {
        id: "s1",
        now: new Date("2026-04-24T12:32:00.001Z")
      })
    ]);
    const winners = [a, b].filter((r) => r !== undefined);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.status).toBe("COMPLETED");
  });

  // race: claimReminderDispatch は claim-first プリミティブ。並行 claim でも先着 1 件のみ
  //   reminder_sent_at をセットでき、後着は undefined。Discord 二重送信の根本防止。
  // @see docs/adr/0024-reminder-dispatch.md
  it("claimReminderDispatch: concurrent claim on same DECIDED session — exactly one wins", async () => {
    await createAskSession(db, { id: "s1", ...baseSession });
    await decideAsking(db, {
      id: "s1",
      now: new Date("2026-04-24T12:31:00.000Z"),
      decidedStartAt: new Date("2026-04-24T14:00:00.000Z"),
      reminderAt: new Date("2026-04-24T13:45:00.000Z")
    });

    const [a, b] = await Promise.all([
      claimReminderDispatch(db, "s1", new Date("2026-04-24T13:45:00.000Z")),
      claimReminderDispatch(db, "s1", new Date("2026-04-24T13:45:00.001Z"))
    ]);
    const winners = [a, b].filter((r) => r !== undefined);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.reminderSentAt).toBeInstanceOf(Date);
  });

  // race: revertReminderClaim は (status=DECIDED, reminder_sent_at=claimedAt) 一致時のみ NULL に戻す。
  //   既に別経路が COMPLETED 化していたら NULL 化しない (誤った re-dispatch を防ぐ)。
  it("revertReminderClaim: only reverts when claimedAt matches and status is still DECIDED", async () => {
    await createAskSession(db, { id: "s1", ...baseSession });
    await decideAsking(db, {
      id: "s1",
      now: new Date("2026-04-24T12:31:00.000Z"),
      decidedStartAt: new Date("2026-04-24T14:00:00.000Z"),
      reminderAt: new Date("2026-04-24T13:45:00.000Z")
    });
    const claimedAt = new Date("2026-04-24T13:45:00.000Z");
    const claim = await claimReminderDispatch(db, "s1", claimedAt);
    expect(claim?.reminderSentAt?.toISOString()).toBe(claimedAt.toISOString());

    // claimedAt mismatch → no-op
    const revertWrong = await revertReminderClaim(
      db,
      "s1",
      new Date("2026-04-24T13:46:00.000Z")
    );
    expect(revertWrong).toBe(false);

    // matching claimedAt → reverted
    const revertOk = await revertReminderClaim(db, "s1", claimedAt);
    expect(revertOk).toBe(true);

    // re-claim must succeed after revert (at-least-once recovery)
    const reclaim = await claimReminderDispatch(
      db,
      "s1",
      new Date("2026-04-24T13:47:00.000Z")
    );
    expect(reclaim?.reminderSentAt?.toISOString()).toBe(
      "2026-04-24T13:47:00.000Z"
    );
  });
});
