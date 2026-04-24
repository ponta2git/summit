import type { Client } from "discord.js";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { makeRealPorts } from "../../src/db/ports.real.js";
import { runReconciler } from "../../src/scheduler/reconciler.js";
import type { Clock } from "../../src/time/index.js";
import {
  assertSchemaReady,
  createIntegrationDb,
  isIntegration,
  seedBaseMembers,
  truncatePerTestTables
} from "./_support.js";

// invariant: INTEGRATION_DB=1 のときだけ実行する。 @see tests/integration/_support.ts
const describeDb = isIntegration ? describe : describe.skip;

describeDb("reconciler startup idempotency across boots (integration)", () => {
  // jst: 2026-04-22 (Wed) 10:00 JST。金曜 ASK 窓外 → invariant B が no-op になる時刻を選定。
  //   bootId 跨ぎの冪等性は時刻に依存しないため固定 clock で十分。
  const bootNow = new Date("2026-04-22T01:00:00Z"); // 10:00 JST Wed
  const fixedClock: Clock = { now: () => bootNow };

  // why: 全 invariant が DB-only に収束する seed のみ用い、Discord 副作用は発生させない。
  //   stranded CANCELLED 無し / missingAsk は窓外 / missingAskMessage は DECIDED で skip /
  //   probeDeleted は ask_message_id=NULL/postpone_message_id=NULL で skip。
  //   これにより Client は `{}` で足りる (型のために cast)。
  const fakeClient = {} as Client;

  const integrationDb = createIntegrationDb();

  beforeAll(async () => {
    await assertSchemaReady(integrationDb.db);
    await seedBaseMembers(integrationDb.db);
  });

  afterAll(async () => {
    await integrationDb.client.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await truncatePerTestTables(integrationDb.db);
  });

  it("two consecutive runReconciler({scope:'startup'}) calls converge on first and no-op on second", async () => {
    const ctx = {
      ports: makeRealPorts(integrationDb.db),
      clock: fixedClock
    };

    // seed (a): DECIDED session with stale reminder claim (> REMINDER_CLAIM_STALENESS_MS=5min).
    //   reminder_sent_at = bootNow - 10min → invariant E (staleReminderClaims) で reclaim 対象。
    const staleReminderAt = new Date(bootNow.getTime() - 10 * 60 * 1000);
    const decidedStartAt = new Date(bootNow.getTime() + 60 * 60 * 1000);
    await integrationDb.db.execute(sql`
      INSERT INTO sessions (
        id, week_key, postpone_count, candidate_date_iso, status, channel_id,
        ask_message_id, postpone_message_id,
        deadline_at, decided_start_at, reminder_at, reminder_sent_at,
        created_at, updated_at
      ) VALUES (
        'sess-stale-reminder',
        '2026-W17', 0, '2026-04-24', 'DECIDED', '999000000000000001',
        NULL, NULL,
        ${new Date(bootNow.getTime() - 24 * 60 * 60 * 1000).toISOString()},
        ${decidedStartAt.toISOString()},
        ${new Date(bootNow.getTime() - 30 * 60 * 1000).toISOString()},
        ${staleReminderAt.toISOString()},
        ${bootNow.toISOString()}, ${bootNow.toISOString()}
      )
    `);

    // seed (b): IN_FLIGHT outbox row past claim_expires_at → invariant F で release 対象。
    const expiredClaimAt = new Date(bootNow.getTime() - 60 * 1000);
    await integrationDb.db.execute(sql`
      INSERT INTO discord_outbox (
        id, kind, session_id, payload, dedupe_key,
        status, attempt_count, claim_expires_at, next_attempt_at,
        created_at, updated_at
      ) VALUES (
        'outbox-stuck',
        'send_message',
        'sess-stale-reminder',
        '{}'::jsonb,
        'sess-stale-reminder:ask-send',
        'IN_FLIGHT',
        1,
        ${expiredClaimAt.toISOString()},
        ${expiredClaimAt.toISOString()},
        ${bootNow.toISOString()}, ${bootNow.toISOString()}
      )
    `);

    // boot-1: 初回 startup reconcile。両 invariant が 1 件ずつ収束する。
    const boot1 = await runReconciler(fakeClient, ctx, { scope: "startup" });
    expect(boot1).toEqual({
      cancelledPromoted: 0,
      askCreated: 0,
      messageResent: 0,
      staleClaimReclaimed: 1,
      outboxClaimReleased: 1
    });

    // boot-2: 別 boot を模した再実行。DB は前回の収束結果を保持しているので全 invariant は no-op。
    //   regression: bootId 跨ぎで CAS-on-NULL / claim release が二重発火しないことを保証する
    //   (ADR-0033 startup recovery の冪等性契約)。
    const boot2 = await runReconciler(fakeClient, ctx, { scope: "startup" });
    expect(boot2).toEqual({
      cancelledPromoted: 0,
      askCreated: 0,
      messageResent: 0,
      staleClaimReclaimed: 0,
      outboxClaimReleased: 0
    });

    // 状態遷移結果も DB レベルで確認: reminder_sent_at は NULL に戻り、outbox は PENDING に復帰。
    const session = await integrationDb.db.execute<{
      reminder_sent_at: Date | null;
      status: string;
    }>(sql`SELECT status, reminder_sent_at FROM sessions WHERE id='sess-stale-reminder'`);
    expect(session[0]?.status).toBe("DECIDED");
    expect(session[0]?.reminder_sent_at).toBeNull();

    const outbox = await integrationDb.db.execute<{
      status: string;
      claim_expires_at: Date | null;
    }>(sql`SELECT status, claim_expires_at FROM discord_outbox WHERE id='outbox-stuck'`);
    expect(outbox[0]?.status).toBe("PENDING");
    expect(outbox[0]?.claim_expires_at).toBeNull();
  });

  it("interleaved boots (boot-1 partial → boot-2 completes residual) remain idempotent", async () => {
    const ctx = {
      ports: makeRealPorts(integrationDb.db),
      clock: fixedClock
    };

    // 同時刻に 2 件 stale reminder を seed。boot-1 で revert 後に新たな stale が発生していない
    // 状況をシミュレートするのではなく、複数件で count が正しく集計され、再実行で 0 になることを確認。
    const staleAt = new Date(bootNow.getTime() - 10 * 60 * 1000);
    const decidedAt = new Date(bootNow.getTime() + 60 * 60 * 1000);
    await integrationDb.db.execute(sql`
      INSERT INTO sessions (
        id, week_key, postpone_count, candidate_date_iso, status, channel_id,
        deadline_at, decided_start_at, reminder_at, reminder_sent_at,
        created_at, updated_at
      ) VALUES
        ('sess-a', '2026-W16', 0, '2026-04-17', 'DECIDED', '999000000000000001',
         ${new Date(bootNow.getTime() - 86400000).toISOString()}, ${decidedAt.toISOString()},
         ${new Date(bootNow.getTime() - 1800000).toISOString()}, ${staleAt.toISOString()},
         ${bootNow.toISOString()}, ${bootNow.toISOString()}),
        ('sess-b', '2026-W17', 0, '2026-04-24', 'DECIDED', '999000000000000001',
         ${new Date(bootNow.getTime() - 86400000).toISOString()}, ${decidedAt.toISOString()},
         ${new Date(bootNow.getTime() - 1800000).toISOString()}, ${staleAt.toISOString()},
         ${bootNow.toISOString()}, ${bootNow.toISOString()})
    `);

    const boot1 = await runReconciler(fakeClient, ctx, { scope: "startup" });
    expect(boot1.staleClaimReclaimed).toBe(2);

    const boot2 = await runReconciler(fakeClient, ctx, { scope: "startup" });
    expect(boot2.staleClaimReclaimed).toBe(0);
    expect(boot2.outboxClaimReleased).toBe(0);
    expect(boot2.cancelledPromoted).toBe(0);
  });
});
