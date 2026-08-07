import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  claimNextOutboxBatch,
  enqueueOutbox,
  findStrandedOutboxEntries,
  markOutboxDelivered,
  markOutboxFailed,
  releaseExpiredOutboxClaims
} from "../../src/db/repositories/outbox.js";
import { discordOutbox } from "../../src/db/schema.js";

import { createOutboxContractHarness } from "./_outboxContract.js";
import { isIntegration } from "./_support.js";

const describeDb = isIntegration ? describe : describe.skip;

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

  // idempotent: dedupe_key partial unique index により 2 回目以降は skipped=true。
  it("enqueueOutbox: second enqueue for same dedupeKey returns skipped=true", async () => {
    const first = await enqueueOutbox(db, {
      kind: "send_message",
      sessionId: baseSession.id,
      payload: basePayload,
      dedupeKey: "ask-dedupe-1"
    });
    expect(first.skipped).toBe(false);

    const second = await enqueueOutbox(db, {
      kind: "send_message",
      sessionId: baseSession.id,
      payload: basePayload,
      dedupeKey: "ask-dedupe-1"
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

  // state: IN_FLIGHT→DELIVERED CAS。既に DELIVERED なら false。
  it("markOutboxDelivered: transitions IN_FLIGHT→DELIVERED and is idempotent", async () => {
    const { id } = await enqueueWithNextAttempt(
      "ask-dedupe-deliver",
      new Date("2026-04-24T12:30:00.000Z")
    );
    const now = new Date("2026-04-24T12:35:00.000Z");
    await claimNextOutboxBatch(db, { limit: 1, now, claimDurationMs: 30_000 });

    const first = await markOutboxDelivered(db, id, {
      deliveredMessageId: "msg-1",
      now: new Date("2026-04-24T12:35:10.000Z")
    });
    expect(first).toBe(true);

    const second = await markOutboxDelivered(db, id, {
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
    await claimNextOutboxBatch(db, { limit: 1, now: t0, claimDurationMs: 30_000 });

    const retried = await markOutboxFailed(db, id, {
      error: "rate limit",
      now: new Date("2026-04-24T12:35:05.000Z"),
      nextAttemptAt: new Date("2026-04-24T12:36:00.000Z")
    });
    expect(retried).toBe(true);

    // re-claim after backoff elapses
    const t1 = new Date("2026-04-24T12:36:30.000Z");
    await claimNextOutboxBatch(db, { limit: 1, now: t1, claimDurationMs: 30_000 });
    const deadLettered = await markOutboxFailed(db, id, {
      error: "fatal",
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

  // race: worker が markDelivered / markFailed を呼ぶ前に crash → IN_FLIGHT で stuck。
  //   reconciler が claim_expires_at <= now を PENDING へ戻す。
  it("releaseExpiredOutboxClaims: resets expired IN_FLIGHT rows to PENDING", async () => {
    const { id } = await enqueueWithNextAttempt(
      "ask-dedupe-expire",
      new Date("2026-04-24T12:30:00.000Z")
    );
    const claimedAt = new Date("2026-04-24T12:35:00.000Z");
    await claimNextOutboxBatch(db, {
      limit: 1,
      now: claimedAt,
      claimDurationMs: 30_000
    });

    // simulate clock moving past claim_expires_at without delivery/failure.
    const after = new Date("2026-04-24T12:36:30.000Z");
    const released = await releaseExpiredOutboxClaims(db, after);
    expect(released).toBe(1);

    const rows = await db
      .select()
      .from(discordOutbox)
      .where(sql`${discordOutbox.id} = ${id}`);
    expect(rows[0]?.status).toBe("PENDING");
    expect(rows[0]?.claimExpiresAt).toBeNull();
  });

  // state: dead letter (FAILED) + attempt_count 閾値超の非終端行を返す。
  it("findStrandedOutboxEntries: surfaces FAILED rows and high-attempt PENDING", async () => {
    const { id: failedId } = await enqueueWithNextAttempt(
      "ask-dedupe-stranded-fail",
      new Date("2026-04-24T12:30:00.000Z")
    );
    const t0 = new Date("2026-04-24T12:35:00.000Z");
    await claimNextOutboxBatch(db, { limit: 1, now: t0, claimDurationMs: 30_000 });
    await markOutboxFailed(db, failedId, {
      error: "fatal",
      now: t0,
      nextAttemptAt: null
    });

    const { id: highAttemptId } = await enqueueWithNextAttempt(
      "ask-dedupe-stranded-high",
      new Date("2026-04-24T12:30:00.000Z")
    );
    // force attempt_count high to match threshold condition.
    await db
      .update(discordOutbox)
      .set({ attemptCount: 9 })
      .where(sql`${discordOutbox.id} = ${highAttemptId}`);

    const stranded = await findStrandedOutboxEntries(db, 5);
    const strandedIds = new Set(stranded.map((r) => r.id));
    expect(strandedIds).toStrictEqual(new Set([failedId, highAttemptId]));
  });
});
