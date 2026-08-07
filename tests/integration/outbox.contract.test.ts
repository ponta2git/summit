import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  claimNextOutboxBatch,
  enqueueOutbox,
  markOutboxDelivered,
  markOutboxFailed
} from "../../src/db/repositories/outbox.js";
import { discordOutbox } from "../../src/db/schema.js";

import { createOutboxContractHarness } from "./_outboxContract.js";
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
  const harness = createOutboxContractHarness();
  const { db, baseSession, basePayload, enqueueWithNextAttempt } = harness;

  beforeAll(async () => {
    await harness.initialize();
  });

  beforeEach(async () => {
    await harness.reset();
  });

  afterAll(async () => {
    await harness.close();
  });

  // idempotent: dedupe_key global unique index により 2 回目以降は skipped=true。
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

  // race: claimNextOutboxBatch は PENDING & next_attempt_at <= now を限定件数だけ CAS で IN_FLIGHT に。
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

  // invariant: nextAttemptAt > now のものは claim されない (backoff 中)。
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

  // race: 並行 claim で同一行を 2 ワーカーが二重に IN_FLIGHT にしない。UPDATE の status CAS で一方は除外される。
  it("claimNextOutboxBatch: concurrent claims do not double-claim the same row", async () => {
    await enqueueWithNextAttempt(
      "ask-dedupe-race",
      new Date("2026-04-24T12:30:00.000Z")
    );

    const now = new Date("2026-04-24T12:35:00.000Z");
    const [a, b] = await Promise.all([
      claimNextOutboxBatch(db, { limit: 5, now, claimDurationMs: 30_000 }),
      claimNextOutboxBatch(db, { limit: 5, now, claimDurationMs: 30_000 })
    ]);
    const totalClaimed = a.length + b.length;
    expect(totalClaimed).toBe(1);
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
      .update(discordOutbox)
      .set({ nextAttemptAt: readyAt })
      .where(sql`${discordOutbox.id} IN (${first.id}, ${second.id})`);

    const now = new Date("2026-04-24T12:35:00.000Z");
    const firstBatch = await claimNextOutboxBatch(db, {
      limit: 10,
      now,
      claimDurationMs: 30_000
    });
    expect(firstBatch.map((row) => row.id)).toStrictEqual([first.id]);
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
        constraint_name: "uq_discord_outbox_session_order"
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

  // state: IN_FLIGHT→DELIVERED CAS。既に DELIVERED なら false。
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
      .update(discordOutbox)
      .set({ lastError: "previous transient failure" })
      .where(sql`${discordOutbox.id} = ${id}`);

    const first = await markOutboxDelivered(db, id, {
      claimToken,
      deliveredMessageId: "msg-1",
      now: new Date("2026-04-24T12:35:10.000Z")
    });
    expect(first).toBe(true);
    const [delivered] = await db
      .select({
        status: discordOutbox.status,
        lastError: discordOutbox.lastError,
        deliveredMessageId: discordOutbox.deliveredMessageId
      })
      .from(discordOutbox)
      .where(sql`${discordOutbox.id} = ${id}`);
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

  // state: nextAttemptAt!==null なら PENDING に戻す (backoff 再試行), null なら FAILED 終端。
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
      .from(discordOutbox)
      .where(sql`${discordOutbox.id} = ${id}`);
    expect(rows[0]?.status).toBe("FAILED");
  });

});
