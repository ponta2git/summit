import type { Client } from "discord.js";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { makeRealPorts } from "../../src/db/ports.real.js";
import { runReconciler } from "../../src/scheduler/reconciler.js";
import type { Clock } from "../../src/time/index.js";
import { unwrapResultAsync } from "../helpers/assertions.js";
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

    // seed (a): DECIDED session used as the outbox foreign-key parent.
    const decidedStartAt = new Date(bootNow.getTime() + 60 * 60 * 1000);
    await integrationDb.db.execute(sql`
      INSERT INTO sessions (
        id, week_key, postpone_count, candidate_date_iso, status, channel_id,
        ask_message_id, postpone_message_id,
        deadline_at, decided_start_at, reminder_at, reminder_sent_at,
        created_at, updated_at
      ) VALUES (
        'sess-outbox-parent',
        '2026-W17', 0, '2026-04-24', 'DECIDED', '999000000000000001',
        NULL, NULL,
        ${new Date(bootNow.getTime() - 24 * 60 * 60 * 1000).toISOString()},
        ${decidedStartAt.toISOString()},
        ${new Date(bootNow.getTime() - 30 * 60 * 1000).toISOString()},
        NULL,
        ${bootNow.toISOString()}, ${bootNow.toISOString()}
      )
    `);

    // seed (b): IN_FLIGHT outbox row past claim_expires_at → invariant F で release 対象。
    const expiredClaimAt = new Date(bootNow.getTime() - 60 * 1000);
    await integrationDb.db.execute(sql`
      SELECT * FROM public.enqueue_discord_attendance_notification(
        'outbox-stuck', 'sess-outbox-parent',
        '{"kind":"send_message","renderer":"ask_body","channelId":"999000000000000001"}'::jsonb,
        'sess-outbox-parent:ask-send', 0, 0::smallint, ${expiredClaimAt.toISOString()}
      )
    `);
    await integrationDb.db.execute(sql`
      SELECT * FROM public.claim_discord_notifications('attendance', 1, ${expiredClaimAt.toISOString()}, 1000)
    `);
    for (const [id, ordinal] of [["outbox-dead-letter", 0], ["outbox-cancelled-successor", 1]] as const) {
      await integrationDb.db.execute(sql`
        SELECT * FROM public.enqueue_discord_attendance_notification(
          ${id}, 'sess-outbox-parent',
          '{"kind":"send_message","renderer":"ask_body","channelId":"999000000000000001"}'::jsonb,
          ${"sess-outbox-parent:" + id}, 1, ${ordinal}::smallint, ${bootNow.toISOString()}
        )
      `);
    }
    await integrationDb.db.execute(sql`UPDATE discord_notifications SET status = 'FAILED',
      attempt_count = 10, last_error = 'fixed by deployment', terminal_at = ${bootNow.toISOString()}
      WHERE id = 'outbox-dead-letter'`);
    await integrationDb.db.execute(sql`SELECT public.cancel_discord_notification(
      'outbox-cancelled-successor', 'predecessor_failed', ${bootNow.toISOString()}
    )`);

    // boot-1: 初回 startup reconcile。expired outbox claim が収束する。
    const boot1 = await unwrapResultAsync(runReconciler(fakeClient, ctx, { scope: "startup" }));
    expect(boot1).toStrictEqual({
      cancelledPromoted: 0,
      askCreated: 0,
      messageIntentsQueued: 0,
      outboxClaimReleased: 1,
      outboxDeadLettersRequeued: 1,
      outboxSuccessorsRequeued: 1,
      failures: []
    });

    // boot-2: 別 boot を模した再実行。DB は前回の収束結果を保持しているので全 invariant は no-op。
    //   regression: bootId 跨ぎで CAS-on-NULL / claim release が二重発火しないことを保証する
    //   startup recovery の冪等性契約を固定する。
    const boot2 = await unwrapResultAsync(runReconciler(fakeClient, ctx, { scope: "startup" }));
    expect(boot2).toStrictEqual({
      cancelledPromoted: 0,
      askCreated: 0,
      messageIntentsQueued: 0,
      outboxClaimReleased: 0,
      outboxDeadLettersRequeued: 0,
      outboxSuccessorsRequeued: 0,
      failures: []
    });

    // 状態遷移結果も DB レベルで確認: Session は不変、outbox は PENDING に復帰。
    const session = await integrationDb.db.execute<{
      reminder_sent_at: Date | null;
      status: string;
    }>(sql`SELECT status, reminder_sent_at FROM sessions WHERE id='sess-outbox-parent'`);
    expect(session[0]?.status).toBe("DECIDED");
    expect(session[0]?.reminder_sent_at).toBeNull();

    const outbox = await integrationDb.db.execute<{
      status: string;
      claim_expires_at: Date | null;
    }>(sql`SELECT status, claim_expires_at FROM discord_notifications WHERE id='outbox-stuck'`);
    expect(outbox[0]?.status).toBe("PENDING");
    expect(outbox[0]?.claim_expires_at).toBeNull();
  });
});
