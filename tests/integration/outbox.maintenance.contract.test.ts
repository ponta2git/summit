import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  claimNextOutboxBatch,
  getOutboxMetrics,
  markOutboxDelivered,
  markOutboxFailed,
  pruneOutbox
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

describeDb("discord_outbox maintenance contract (integration)", () => {
  const harness = createOutboxContractHarness();
  const { db, baseSession, enqueueWithNextAttempt } = harness;

  beforeAll(async () => {
    await harness.initialize();
  });

  beforeEach(async () => {
    await harness.reset();
  });

  afterAll(async () => {
    await harness.close();
  });

  it("DB rejects outbox kinds without a delivery implementation", async () => {
    await expect(db.execute(sql`
      INSERT INTO discord_outbox (id, kind, session_id, payload, dedupe_key)
      VALUES (
        'unsupported-kind-row',
        'edit_message',
        ${baseSession.id},
        '{"kind":"edit_message"}'::jsonb,
        'unsupported-kind-dedupe'
      )
    `)).rejects.toMatchObject({
      cause: {
        code: "23514",
        constraint_name: "discord_outbox_kind_check"
      }
    });
  });

  // invariant: DELIVERED / FAILED の期限切れだけを削除し、PENDING は保持する。@see ADR-0042
  it("pruneOutbox deletes only expired terminal rows", async () => {
    const oldDelivered = new Date("2026-04-01T00:00:00.000Z");
    const recent = new Date("2026-04-23T00:00:00.000Z");
    const now = new Date("2026-04-24T00:00:00.000Z");

    const { id: oldDeliveredId } = await enqueueWithNextAttempt(
      "prune-old-delivered",
      new Date("2026-03-30T00:00:00.000Z")
    );
    const oldDeliveredClaim = await claimNextOutboxBatch(
      db,
      { limit: 1, now: oldDelivered, claimDurationMs: 30_000 }
    );
    await markOutboxDelivered(db, oldDeliveredId, {
      claimToken: claimTokenOf(oldDeliveredClaim),
      deliveredMessageId: "msg-1",
      now: oldDelivered
    });
    await db
      .update(discordOutbox)
      .set({ deliveredAt: oldDelivered })
      .where(sql`${discordOutbox.id} = ${oldDeliveredId}`);

    const { id: recentDeliveredId } = await enqueueWithNextAttempt(
      "prune-recent-delivered",
      new Date("2026-04-22T00:00:00.000Z")
    );
    const recentDeliveredClaim = await claimNextOutboxBatch(
      db,
      { limit: 1, now: recent, claimDurationMs: 30_000 }
    );
    await markOutboxDelivered(db, recentDeliveredId, {
      claimToken: claimTokenOf(recentDeliveredClaim),
      deliveredMessageId: "msg-2",
      now: recent
    });
    await db
      .update(discordOutbox)
      .set({ deliveredAt: recent })
      .where(sql`${discordOutbox.id} = ${recentDeliveredId}`);

    const oldFailedAt = new Date("2026-03-20T00:00:00.000Z");
    const { id: oldFailedId } = await enqueueWithNextAttempt("prune-old-failed", oldFailedAt);
    const oldFailedClaim = await claimNextOutboxBatch(
      db,
      { limit: 1, now: oldFailedAt, claimDurationMs: 30_000 }
    );
    await markOutboxFailed(db, oldFailedId, {
      error: "boom",
      claimToken: claimTokenOf(oldFailedClaim),
      now: oldFailedAt,
      nextAttemptAt: null
    });
    await db
      .update(discordOutbox)
      .set({ updatedAt: oldFailedAt })
      .where(sql`${discordOutbox.id} = ${oldFailedId}`);

    const { id: pendingId } = await enqueueWithNextAttempt(
      "prune-pending",
      new Date("2026-03-30T00:00:00.000Z")
    );

    expect(await pruneOutbox(db, {
      deliveredOlderThan: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1_000),
      failedOlderThan: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1_000)
    })).toStrictEqual({ deliveredPruned: 1, failedPruned: 1, cancelledPruned: 0 });

    const remainingIds = new Set(
      (await db.select({ id: discordOutbox.id }).from(discordOutbox)).map((row) => row.id)
    );
    expect(remainingIds).toStrictEqual(new Set([recentDeliveredId, pendingId]));
  });

  // invariant: status 別件数と最古 age の基準列を固定する。@see ADR-0043
  it("getOutboxMetrics reports exact non-delivered counts and ages", async () => {
    const now = new Date("2026-04-25T01:00:00.000Z");
    const oldPendingAt = new Date(now.getTime() - 10 * 60_000);
    const recentPendingAt = new Date(now.getTime() - 30_000);
    const failedAt = new Date(now.getTime() - 5 * 60_000);

    const { id: oldPendingId } = await enqueueWithNextAttempt("metrics-pending-old", oldPendingAt);
    await db.update(discordOutbox).set({ createdAt: oldPendingAt })
      .where(sql`${discordOutbox.id} = ${oldPendingId}`);

    const { id: recentPendingId } = await enqueueWithNextAttempt(
      "metrics-pending-recent",
      recentPendingAt
    );
    await db.update(discordOutbox).set({ createdAt: recentPendingAt })
      .where(sql`${discordOutbox.id} = ${recentPendingId}`);

    const { id: failedId } = await enqueueWithNextAttempt("metrics-failed", failedAt);
    await db.update(discordOutbox).set({ status: "FAILED", updatedAt: failedAt })
      .where(sql`${discordOutbox.id} = ${failedId}`);

    const { id: deliveredId } = await enqueueWithNextAttempt("metrics-delivered", now);
    await db.update(discordOutbox).set({ status: "DELIVERED", deliveredAt: now })
      .where(sql`${discordOutbox.id} = ${deliveredId}`);

    expect(await getOutboxMetrics(db, now)).toStrictEqual({
      pending: 2,
      inFlight: 0,
      failed: 1,
      oldestPendingAgeMs: 10 * 60_000,
      oldestFailedAgeMs: 5 * 60_000
    });
  });
});
