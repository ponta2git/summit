import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  claimNextOutboxBatch,
  beginOutboxDelivery,
  enqueueOutbox,
  markOutboxDelivered,
  markOutboxFailed
} from "../../src/db/repositories/outbox.js";
import { discordNotifications, discordNotificationParts } from "../../src/db/schema.js";

import { createOutboxContractHarness } from "./_outboxContract.js";
import { deferred } from "../helpers/deferred.ts";
import { lockNotificationFamily } from "../../src/db/repositories/notifications.storage.ts";
import { waitForBlockedBy, waitForLockWaiters } from "./locking.ts";
import { isIntegration } from "./_support.js";

const describeDb = isIntegration ? describe : describe.skip;

const claimTokenOf = (
  rows: Awaited<ReturnType<typeof claimNextOutboxBatch>>
): string => {
  const token = rows[0]?.claimToken;
  expect(token).toBeTypeOf("string");
  if (!token) {throw new Error("Expected claimed outbox token");}
  return token;
};

describeDb("discord_outbox repository contract (integration)", () => {
  const harness = createOutboxContractHarness({ maxConnections: 4 });
  const { db, baseSession, basePayload, enqueueWithNextAttempt } = harness;

  beforeAll(() => harness.initialize());

  beforeEach(() => harness.reset());

  afterAll(() => harness.close());

  it("enqueueOutbox: second enqueue for same dedupeKey returns skipped=true", async () => {
    const first = await enqueueOutbox(db, {
      kind: "send_message",
      sessionId: baseSession.id,
      payload: basePayload,
      dedupeKey: "ask-dedupe-1",
      aggregateRevision: 0,
      ordinal: 0
    });
    expect(first.skipped).toBe(false);

    const second = await enqueueOutbox(db, {
      kind: "send_message",
      sessionId: baseSession.id,
      payload: basePayload,
      dedupeKey: "ask-dedupe-1",
      aggregateRevision: 0,
      ordinal: 0
    });
    expect(second.skipped).toBe(true);
    expect(second.id).toBe(first.id);
  });

  it("claimNextOutboxBatch: transitions PENDING rows to IN_FLIGHT with claim_expires_at", async () => {
    const readyAt = new Date("2026-04-24T12:30:00.000Z");
    await enqueueWithNextAttempt("ask-dedupe-claim", readyAt);

    const now = new Date("2026-04-24T12:35:00.000Z");
    const claimed = await claimNextOutboxBatch(db, {
      limit: 10,
      now,
      claimDurationMs: 30_000
    });
    expect(claimed).toHaveLength(1);
    const [row] = claimed;
    expect(row?.status).toBe("IN_FLIGHT");
    expect(row?.attemptCount).toBe(1);
    expect(row?.claimExpiresAt?.toISOString()).toBe(
      "2026-04-24T12:35:30.000Z"
    );
  });

  it("claimNextOutboxBatch: skips rows whose nextAttemptAt is in the future", async () => {
    await enqueueWithNextAttempt(
      "ask-dedupe-future",
      new Date("2026-04-24T13:00:00.000Z")
    );

    const now = new Date("2026-04-24T12:35:00.000Z");
    const claimed = await claimNextOutboxBatch(db, {
      limit: 10,
      now,
      claimDurationMs: 30_000
    });
    expect(claimed).toHaveLength(0);
  });

  it("claimNextOutboxBatch: concurrent claims do not double-claim the same row", async () => {
    await enqueueWithNextAttempt(
      "ask-dedupe-race",
      new Date("2026-04-24T12:30:00.000Z")
    );

    const now = new Date("2026-04-24T12:35:00.000Z");
    const locked = deferred<number>(); const release = deferred<void>();
    const blocker = db.transaction(async tx => {
      await lockNotificationFamily(tx, "attendance");
      const [backend] = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      locked.resolve(backend!.pid); await release.promise;
    });
    const pid = await locked.promise;
    const first = claimNextOutboxBatch(db, { limit: 5, now, claimDurationMs: 30_000 });
    let second: ReturnType<typeof claimNextOutboxBatch>;
    try {
      await waitForBlockedBy(harness.client, pid);
      second = claimNextOutboxBatch(db, { limit: 5, now, claimDurationMs: 30_000 });
      await waitForLockWaiters(harness.client, 2);
    } finally { release.resolve(); await blocker; }
    const results = await Promise.all([first, second]);
    const [winner, loser] = results.sort((a, b) => b.length - a.length);
    if (!winner) { throw new Error("Expected claim winner"); }
    expect(winner.map(row => ({ status: row.status, attemptCount: row.attemptCount })))
      .toStrictEqual([{ status: "IN_FLIGHT", attemptCount: 1 }]);
    expect(loser).toStrictEqual([]);
    expect(await db.select({ status: discordNotifications.status, attemptCount: discordNotifications.attemptCount }).from(discordNotifications))
      .toStrictEqual([{ status: "IN_FLIGHT", attemptCount: 1 }]);
  });

  it("claimNextOutboxBatch: serializes one session by aggregate revision and ordinal", async () => {
    const readyAt = new Date("2026-04-24T12:30:00.000Z");
    const second = await enqueueOutbox(db, {
      kind: "send_message",
      sessionId: baseSession.id,
      payload: basePayload,
      dedupeKey: "ordered-second",
      aggregateRevision: 2,
      ordinal: 1
    });
    const first = await enqueueOutbox(db, {
      kind: "send_message",
      sessionId: baseSession.id,
      payload: basePayload,
      dedupeKey: "ordered-first",
      aggregateRevision: 2,
      ordinal: 0
    });
    await db
      .update(discordNotifications)
      .set({ nextAttemptAt: readyAt })
      .where(sql`${discordNotifications.id} IN (${first.id}, ${second.id})`);

    const now = new Date("2026-04-24T12:35:00.000Z");
    const firstBatch = await claimNextOutboxBatch(db, {
      limit: 10,
      now,
      claimDurationMs: 30_000
    });
    expect(firstBatch.map((row) => row.id)).toStrictEqual([first.id]);
    expect(await beginOutboxDelivery(db, first.id, { claimToken: claimTokenOf(firstBatch), now })).toBe(true);
    await markOutboxDelivered(db, first.id, {
      claimToken: claimTokenOf(firstBatch),
      deliveredMessageId: "ordered-message-1",
      now
    });

    const secondBatch = await claimNextOutboxBatch(db, {
      limit: 10,
      now,
      claimDurationMs: 30_000
    });
    expect(secondBatch.map((row) => row.id)).toStrictEqual([second.id]);
  });

  it("rejects duplicate aggregate revision and ordinal within one Session", async () => {
    const input = {
      kind: "send_message" as const,
      sessionId: baseSession.id,
      payload: basePayload,
      aggregateRevision: 7,
      ordinal: 0
    };
    await enqueueOutbox(db, { ...input, dedupeKey: "order-unique-first" });

    await expect(
      enqueueOutbox(db, { ...input, dedupeKey: "order-unique-second" })
    ).rejects.toMatchObject({
      cause: {
        code: "23505",
        constraint_name: "discord_notification_attendance_order_unique"
      }
    });
  });

  it("claim fencing rejects an expired owner after a reclaim", async () => {
    const { id } = await enqueueWithNextAttempt(
      "claim-fencing",
      new Date("2026-04-24T12:30:00.000Z")
    );
    const claimedAt = new Date("2026-04-24T12:35:00.000Z");
    const expired = await claimNextOutboxBatch(db, {
      limit: 1,
      now: claimedAt,
      claimDurationMs: 30_000
    });
    const current = await claimNextOutboxBatch(db, {
      limit: 1,
      now: new Date("2026-04-24T12:35:30.000Z"),
      claimDurationMs: 30_000
    });
    const expiredToken = claimTokenOf(expired);
    const currentToken = claimTokenOf(current);
    expect(currentToken).not.toBe(expiredToken);
    expect(await beginOutboxDelivery(db, id, {
      claimToken: expiredToken, now: new Date("2026-04-24T12:35:31.000Z")
    })).toBe(false);
    expect(await beginOutboxDelivery(db, id, {
      claimToken: currentToken, now: new Date("2026-04-24T12:35:31.000Z")
    })).toBe(true);

    expect(await markOutboxDelivered(db, id, {
      claimToken: expiredToken,
      deliveredMessageId: "stale-owner",
      now: new Date("2026-04-24T12:35:31.000Z")
    })).toBe(false);
    expect(await markOutboxDelivered(db, id, {
      claimToken: currentToken,
      deliveredMessageId: "current-owner",
      now: new Date("2026-04-24T12:35:31.000Z")
    })).toBe(true);
  });

  it("markOutboxDelivered: transitions IN_FLIGHT→DELIVERED and is idempotent", async () => {
    const { id } = await enqueueWithNextAttempt(
      "ask-dedupe-deliver",
      new Date("2026-04-24T12:30:00.000Z")
    );
    const now = new Date("2026-04-24T12:35:00.000Z");
    const claimed = await claimNextOutboxBatch(
      db,
      { limit: 1, now, claimDurationMs: 30_000 }
    );
    const claimToken = claimTokenOf(claimed);
    await db
      .update(discordNotifications)
      .set({ lastError: "previous transient failure" })
      .where(sql`${discordNotifications.id} = ${id}`);

    expect(await beginOutboxDelivery(db, id, { claimToken, now })).toBe(true);
    const first = await markOutboxDelivered(db, id, {
      claimToken,
      deliveredMessageId: "msg-1",
      now: new Date("2026-04-24T12:35:10.000Z")
    });
    expect(first).toBe(true);
    const [delivered] = await db
      .select({
        status: discordNotifications.status,
        lastError: discordNotifications.lastError,
        deliveredMessageId: discordNotificationParts.deliveredMessageId
      })
      .from(discordNotifications)
      .innerJoin(discordNotificationParts, eq(discordNotificationParts.notificationId, discordNotifications.id))
      .where(sql`${discordNotifications.id} = ${id}`);
    expect(delivered).toStrictEqual({
      status: "DELIVERED",
      lastError: null,
      deliveredMessageId: "msg-1"
    });

    const second = await markOutboxDelivered(db, id, {
      claimToken,
      deliveredMessageId: "msg-1",
      now: new Date("2026-04-24T12:35:11.000Z")
    });
    expect(second).toBe(false);
  });

  it("markOutboxFailed: routes to PENDING when retry scheduled, FAILED when dead-lettered", async () => {
    const { id } = await enqueueWithNextAttempt(
      "ask-dedupe-fail",
      new Date("2026-04-24T12:30:00.000Z")
    );
    const t0 = new Date("2026-04-24T12:35:00.000Z");
    const firstClaim = await claimNextOutboxBatch(
      db,
      { limit: 1, now: t0, claimDurationMs: 30_000 }
    );

    const retried = await markOutboxFailed(db, id, {
      error: "rate limit",
      claimToken: claimTokenOf(firstClaim),
      now: new Date("2026-04-24T12:35:05.000Z"),
      nextAttemptAt: new Date("2026-04-24T12:36:00.000Z")
    });
    expect(retried).toBe(true);

    // re-claim after backoff elapses
    const t1 = new Date("2026-04-24T12:36:30.000Z");
    const secondClaim = await claimNextOutboxBatch(
      db,
      { limit: 1, now: t1, claimDurationMs: 30_000 }
    );
    const deadLettered = await markOutboxFailed(db, id, {
      error: "fatal",
      claimToken: claimTokenOf(secondClaim),
      now: new Date("2026-04-24T12:36:31.000Z"),
      nextAttemptAt: null
    });
    expect(deadLettered).toBe(true);

    const rows = await db
      .select()
      .from(discordNotifications)
      .where(sql`${discordNotifications.id} = ${id}`);
    expect(rows[0]?.status).toBe("FAILED");
  });
});
