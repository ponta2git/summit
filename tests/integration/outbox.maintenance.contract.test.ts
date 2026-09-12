import { isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  claimNextOutboxBatch,
  beginOutboxDelivery,
  enqueueOutbox,
  getOutboxMetrics,
  markOutboxDelivered,
  markOutboxFailed,
  pruneOutbox
} from "../../src/db/repositories/outbox.js";
import { discordNotifications } from "../../src/db/schema.js";
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

  it("DB rejects outbox kinds without a delivery implementation", async () => {
    await expect(db.execute(sql`
      INSERT INTO discord_notifications (id, family, kind, payload, dedupe_key, payload_hash)
      VALUES (
        'unsupported-kind-row',
        'attendance',
        'edit_message',
        '{"kind":"edit_message"}'::jsonb,
        'unsupported-kind-dedupe',
        repeat('0', 64)
      )
    `)).rejects.toMatchObject({
      cause: {
        code: "23514",
        constraint_name: "discord_notifications_kind_check"
      }
    });
  });

  // invariant: 本文整理後も同じ dedupe key から通知を再生成しない。
  it("pruneOutbox retains permanent identities and only purges expired terminal detail", async () => {
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
    await beginOutboxDelivery(db, oldDeliveredId, {
      claimToken: claimTokenOf(oldDeliveredClaim), now: oldDelivered
    });
    await markOutboxDelivered(db, oldDeliveredId, {
      claimToken: claimTokenOf(oldDeliveredClaim),
      deliveredMessageId: "msg-1",
      now: oldDelivered
    });
    await db
      .update(discordNotifications)
      .set({ deliveredAt: oldDelivered })
      .where(sql`${discordNotifications.id} = ${oldDeliveredId}`);

    const { id: recentDeliveredId } = await enqueueWithNextAttempt(
      "prune-recent-delivered",
      new Date("2026-04-22T00:00:00.000Z")
    );
    const recentDeliveredClaim = await claimNextOutboxBatch(
      db,
      { limit: 1, now: recent, claimDurationMs: 30_000 }
    );
    await beginOutboxDelivery(db, recentDeliveredId, {
      claimToken: claimTokenOf(recentDeliveredClaim), now: recent
    });
    await markOutboxDelivered(db, recentDeliveredId, {
      claimToken: claimTokenOf(recentDeliveredClaim),
      deliveredMessageId: "msg-2",
      now: recent
    });
    await db
      .update(discordNotifications)
      .set({ deliveredAt: recent })
      .where(sql`${discordNotifications.id} = ${recentDeliveredId}`);

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
      .update(discordNotifications)
      .set({ updatedAt: oldFailedAt })
      .where(sql`${discordNotifications.id} = ${oldFailedId}`);

    const { id: pendingId } = await enqueueWithNextAttempt(
      "prune-pending",
      new Date("2026-03-30T00:00:00.000Z")
    );

    expect(await pruneOutbox(db, {
      deliveredOlderThan: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1_000),
      failedOlderThan: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1_000)
    })).toStrictEqual({ deliveredPruned: 1, failedPruned: 1, cancelledPruned: 0 });

    const remainingIds = new Set(
      (await db.select({ id: discordNotifications.id }).from(discordNotifications)
        .where(isNull(discordNotifications.purgedAt))).map((row) => row.id)
    );
    expect(remainingIds).toStrictEqual(new Set([recentDeliveredId, pendingId]));
    expect(await db.select({ id: discordNotifications.id }).from(discordNotifications)).toHaveLength(4);
    expect(await enqueueOutbox(db, {
      kind: "send_message", sessionId: baseSession.id, payload: basePayload,
      dedupeKey: "prune-old-delivered", aggregateRevision: 0, ordinal: 0
    })).toStrictEqual({ id: oldDeliveredId, skipped: true });
  });

  // invariant: status 別件数と最古 age の基準列を固定する。
  it("getOutboxMetrics reports exact non-delivered counts and ages", async () => {
    const now = new Date("2026-04-25T01:00:00.000Z");
    const oldPendingAt = new Date(now.getTime() - 10 * 60_000);
    const recentPendingAt = new Date(now.getTime() - 30_000);
    const failedAt = new Date(now.getTime() - 5 * 60_000);

    const { id: oldPendingId } = await enqueueWithNextAttempt("metrics-pending-old", oldPendingAt);
    await db.update(discordNotifications).set({ createdAt: oldPendingAt })
      .where(sql`${discordNotifications.id} = ${oldPendingId}`);

    const { id: recentPendingId } = await enqueueWithNextAttempt(
      "metrics-pending-recent",
      recentPendingAt
    );
    await db.update(discordNotifications).set({ createdAt: recentPendingAt })
      .where(sql`${discordNotifications.id} = ${recentPendingId}`);

    const { id: failedId } = await enqueueWithNextAttempt("metrics-failed", failedAt);
    await db.update(discordNotifications).set({ status: "FAILED", updatedAt: failedAt })
      .where(sql`${discordNotifications.id} = ${failedId}`);

    const { id: deliveredId } = await enqueueWithNextAttempt("metrics-delivered", now);
    await db.transaction(async (tx) => {
      await tx.execute(sql`UPDATE discord_notification_parts SET status = 'DELIVERED',
        delivered_at = ${now.toISOString()}, delivered_message_id = 'metrics-delivered-message'
        WHERE notification_id = ${deliveredId}`);
      await tx.update(discordNotifications).set({ status: "DELIVERED", deliveredAt: now, terminalAt: now })
        .where(sql`${discordNotifications.id} = ${deliveredId}`);
    });

    expect(await getOutboxMetrics(db, now)).toStrictEqual({
      pending: 2,
      inFlight: 0,
      failed: 1,
      oldestPendingAgeMs: 10 * 60_000,
      oldestFailedAgeMs: 5 * 60_000
    });
  });
});
