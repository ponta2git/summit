import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  claimNextOutboxBatch,
  enqueueOutbox,
  findStrandedOutboxEntries,
  getOutboxMetrics,
  markOutboxDelivered,
  markOutboxFailed,
  pruneOutbox,
  releaseExpiredOutboxClaims,
  type OutboxPayload
} from "../../src/db/repositories/outbox.js";
import { createAskSession } from "../../src/db/repositories/sessions.js";
import { discordOutbox } from "../../src/db/schema.js";

import {
  assertSchemaReady,
  createIntegrationDb,
  isIntegration,
  seedBaseMembers,
  truncatePerTestTables
} from "./_support.js";

const describeDb = isIntegration ? describe : describe.skip;

describeDb("discord_outbox repository contract (integration)", () => {
  const { db, client } = createIntegrationDb();

  const baseSession = {
    id: "sess-outbox",
    weekKey: "2026-W17",
    postponeCount: 0,
    candidateDateIso: "2026-04-24",
    channelId: "channel-1",
    deadlineAt: new Date("2026-04-24T12:30:00.000Z")
  } as const;

  const basePayload: OutboxPayload = {
    kind: "send_message",
    renderer: "ask_body",
    channelId: "channel-1",
    target: "askMessageId"
  };

  // why: enqueueOutbox は next_attempt_at = DEFAULT now() (wall-clock) で挿入する。
  //   integration test は決定論的時刻で claim/backoff を検証したいので、挿入直後に
  //   固定時刻まで後戻しして「test clock で claim 可能」な状態を作る。
  const forceNextAttemptAt = async (
    dedupeKey: string,
    at: Date
  ): Promise<void> => {
    await db
      .update(discordOutbox)
      .set({ nextAttemptAt: at })
      .where(sql`${discordOutbox.dedupeKey} = ${dedupeKey}`);
  };

  const enqueueWithNextAttempt = async (
    dedupeKey: string,
    nextAttemptAt: Date
  ): Promise<{ id: string }> => {
    const result = await enqueueOutbox(db, {
      kind: "send_message",
      sessionId: baseSession.id,
      payload: basePayload,
      dedupeKey
    });
    await forceNextAttemptAt(dedupeKey, nextAttemptAt);
    return { id: result.id };
  };

  beforeAll(async () => {
    await assertSchemaReady(db);
    await seedBaseMembers(db);
  });

  beforeEach(async () => {
    await truncatePerTestTables(db);
    await createAskSession(db, { ...baseSession });
  });

  afterAll(async () => {
    await client.end({ timeout: 5 });
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
    expect(strandedIds.has(failedId)).toBe(true);
    expect(strandedIds.has(highAttemptId)).toBe(true);
  });

  // invariant: pruneOutbox は DELIVERED / FAILED のみ削除し、PENDING / IN_FLIGHT には触れない。
  // @see ADR-0042
  it("pruneOutbox: deletes only DELIVERED past delivered_at and FAILED past updated_at", async () => {
    const oldDelivered = new Date("2026-04-01T00:00:00.000Z");
    const oldFailed = new Date("2026-04-01T00:00:00.000Z");
    const recent = new Date("2026-04-23T00:00:00.000Z");
    const now = new Date("2026-04-24T00:00:00.000Z");

    // DELIVERED past retention -> pruned
    const { id: oldDelId } = await enqueueWithNextAttempt(
      "prune-old-delivered",
      new Date("2026-03-30T00:00:00.000Z")
    );
    await claimNextOutboxBatch(db, {
      limit: 1,
      now: oldDelivered,
      claimDurationMs: 30_000
    });
    await markOutboxDelivered(db, oldDelId, {
      deliveredMessageId: "msg-1",
      now: oldDelivered
    });
    await db
      .update(discordOutbox)
      .set({ deliveredAt: oldDelivered })
      .where(sql`${discordOutbox.id} = ${oldDelId}`);

    // DELIVERED recent -> kept
    const { id: recentDelId } = await enqueueWithNextAttempt(
      "prune-recent-delivered",
      new Date("2026-04-22T00:00:00.000Z")
    );
    await claimNextOutboxBatch(db, {
      limit: 1,
      now: recent,
      claimDurationMs: 30_000
    });
    await markOutboxDelivered(db, recentDelId, {
      deliveredMessageId: "msg-2",
      now: recent
    });
    await db
      .update(discordOutbox)
      .set({ deliveredAt: recent })
      .where(sql`${discordOutbox.id} = ${recentDelId}`);

    // FAILED past retention -> pruned
    const { id: oldFailedId } = await enqueueWithNextAttempt(
      "prune-old-failed",
      new Date("2026-03-30T00:00:00.000Z")
    );
    await claimNextOutboxBatch(db, {
      limit: 1,
      now: oldFailed,
      claimDurationMs: 30_000
    });
    await markOutboxFailed(db, oldFailedId, {
      error: "boom",
      now: oldFailed,
      nextAttemptAt: null
    });
    await db
      .update(discordOutbox)
      .set({ updatedAt: oldFailed })
      .where(sql`${discordOutbox.id} = ${oldFailedId}`);

    // PENDING regardless of age -> kept
    const { id: pendingId } = await enqueueWithNextAttempt(
      "prune-pending",
      new Date("2026-03-30T00:00:00.000Z")
    );

    const result = await pruneOutbox(db, {
      deliveredOlderThan: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1_000),
      failedOlderThan: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1_000)
    });

    expect(result.deliveredPruned).toBe(1);
    expect(result.failedPruned).toBe(1);

    const remainingIds = (
      await db.select({ id: discordOutbox.id }).from(discordOutbox)
    ).map((r) => r.id);
    expect(remainingIds).toContain(recentDelId);
    expect(remainingIds).toContain(pendingId);
    expect(remainingIds).not.toContain(oldDelId);
    expect(remainingIds).not.toContain(oldFailedId);
  });

  // invariant: getOutboxMetrics は PENDING / IN_FLIGHT / FAILED を独立カウントし、
  //   oldest age は createdAt(PENDING) / updatedAt(FAILED) を基準に算出する。@see ADR-0043
  it("getOutboxMetrics: counts non-DELIVERED status and reports oldest age", async () => {
    const now = new Date("2026-04-25T01:00:00.000Z");
    const oldPendingTs = new Date(now.getTime() - 10 * 60_000);
    const recentPendingTs = new Date(now.getTime() - 30_000);
    const failedTs = new Date(now.getTime() - 5 * 60_000);

    const { id: oldPendingId } = await enqueueWithNextAttempt(
      "metrics-pending-old",
      oldPendingTs
    );
    await db
      .update(discordOutbox)
      .set({ createdAt: oldPendingTs })
      .where(sql`${discordOutbox.id} = ${oldPendingId}`);

    const { id: recentPendingId } = await enqueueWithNextAttempt(
      "metrics-pending-recent",
      recentPendingTs
    );
    await db
      .update(discordOutbox)
      .set({ createdAt: recentPendingTs })
      .where(sql`${discordOutbox.id} = ${recentPendingId}`);

    // FAILED row
    const { id: failedId } = await enqueueWithNextAttempt(
      "metrics-failed",
      failedTs
    );
    await claimNextOutboxBatch(db, { limit: 1, now: failedTs, claimDurationMs: 30_000 });
    await markOutboxFailed(db, failedId, {
      error: "boom",
      now: failedTs,
      nextAttemptAt: null
    });
    await db
      .update(discordOutbox)
      .set({ updatedAt: failedTs })
      .where(sql`${discordOutbox.id} = ${failedId}`);

    // DELIVERED row should NOT count
    const { id: deliveredId } = await enqueueWithNextAttempt(
      "metrics-delivered",
      now
    );
    await claimNextOutboxBatch(db, { limit: 1, now, claimDurationMs: 30_000 });
    await markOutboxDelivered(db, deliveredId, {
      deliveredMessageId: "msg-x",
      now
    });

    const metrics = await getOutboxMetrics(db, now);

    expect(metrics.pending).toBe(2);
    expect(metrics.inFlight).toBe(0);
    expect(metrics.failed).toBe(1);
    expect(metrics.oldestPendingAgeMs).toBe(10 * 60_000);
    expect(metrics.oldestFailedAgeMs).toBe(5 * 60_000);
  });
});
