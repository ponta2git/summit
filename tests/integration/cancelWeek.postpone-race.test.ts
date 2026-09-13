import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { cancelWeekAtomically, settlePostponeVoting } from "../../src/db/repositories/sessionCommands.ts";
import { discordNotificationAttendance, discordNotifications, responses, sessions } from "../../src/db/schema.ts";
import { deferred } from "../helpers/deferred.ts";
import { makeResponse } from "../testing/fixtures.ts";
import { fridayPostponeVoting, saturdayAsking } from "../testing/sessionScenario.ts";
import { createIntegrationDb, isIntegration, seedBaseMembers, truncatePerTestTables } from "./_support.ts";
import { waitForBlockedBy, waitForLockWaiters } from "./locking.ts";

const describeDb = isIntegration ? describe : describe.skip;

describeDb("cancel_week and Saturday creation (integration)", () => {
  const { db, client } = createIntegrationDb({ maxConnections: 4 });
  const friday = fridayPostponeVoting({ id: "friday" });
  const saturday = saturdayAsking({ id: "saturday" });
  const now = new Date("2026-04-24T13:00:00Z");

  beforeEach(async () => {
    await truncatePerTestTables(db);
    await seedBaseMembers(db);
    await db.insert(sessions).values(friday);
    await db.insert(responses).values(["m1", "m2", "m3", "m4"].map(memberId => makeResponse({
      id: `response-${memberId}`, sessionId: friday.id, memberId, choice: "POSTPONE_OK", answeredAt: now
    })));
  });

  it("cancels the Saturday session committed while cancellation waits for Friday", async () => {
    const locked = deferred<number>();
    const release = deferred<void>();
    const blocker = db.transaction(async tx => {
      await tx.select().from(sessions).where(eq(sessions.id, friday.id)).for("update");
      const [backend] = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      if (!backend) { throw new Error("Missing blocker backend"); }
      locked.resolve(backend.pid);
      await release.promise;
    });
    const pid = await locked.promise;
    const postponed = settlePostponeVoting(db, {
      sessionId: friday.id, now, memberCountExpected: 4,
      saturday: { id: saturday.id, candidateDateIso: saturday.candidateDateIso, deadlineAt: saturday.deadlineAt }
    });
    let cancelled: ReturnType<typeof cancelWeekAtomically> | undefined;
    try {
      await waitForBlockedBy(client, pid);
      cancelled = cancelWeekAtomically(db, {
        sentinelSessionId: "unused-sentinel", weekKey: friday.weekKey,
        candidateDateIso: friday.candidateDateIso, deadlineAt: friday.deadlineAt,
        channelId: friday.channelId!, invokerUserId: "333333333333333333", suppressMentions: true, now
      });
      await waitForLockWaiters(client, 2);
    } finally {
      release.resolve();
      // assert/waitの失敗時も未完了transactionを次testへ持ち越さない。
      await Promise.allSettled([blocker, postponed, cancelled]);
    }
    await blocker;
    expect(await postponed).toMatchObject({ kind: "transitioned", outcome: "all_ok" });
    expect(await cancelled).toMatchObject({ kind: "applied" });
    expect(await db.select({ id: sessions.id, status: sessions.status }).from(sessions).orderBy(sessions.id))
      .toStrictEqual([{ id: friday.id, status: "SKIPPED" }, { id: saturday.id, status: "SKIPPED" }]);
    expect(await db.select({ sessionId: discordNotificationAttendance.sessionId, status: discordNotifications.status })
      .from(discordNotifications)
      .innerJoin(discordNotificationAttendance, eq(discordNotificationAttendance.notificationId, discordNotifications.id))
      .orderBy(discordNotificationAttendance.sessionId))
      .toStrictEqual([{ sessionId: friday.id, status: "PENDING" }, { sessionId: saturday.id, status: "CANCELLED" }]);
  });
});
