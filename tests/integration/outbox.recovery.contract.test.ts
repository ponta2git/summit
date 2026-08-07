import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  claimNextOutboxBatch,
  enqueueOutbox,
  findStrandedOutboxEntries,
  markOutboxFailed,
  requeueFailedOutboxChains,
  releaseExpiredOutboxClaims
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

describeDb("discord_outbox recovery contract (integration)", () => {
  const harness = createOutboxContractHarness();
  const { db, baseSession, basePayload, enqueueWithNextAttempt } = harness;

  beforeAll(() => harness.initialize());
  beforeEach(() => harness.reset());
  afterAll(() => harness.close());

  it("dead-lettering cancels existing and future ordered successors", async () => {
    const readyAt = new Date("2026-04-24T12:30:00.000Z");
    const first = await enqueueOutbox(db, {
      kind: "send_message",
      sessionId: baseSession.id,
      payload: basePayload,
      dedupeKey: "dead-letter-first",
      aggregateRevision: 3,
      ordinal: 0
    });
    const existingSuccessor = await enqueueOutbox(db, {
      kind: "send_message",
      sessionId: baseSession.id,
      payload: basePayload,
      dedupeKey: "dead-letter-existing-successor",
      aggregateRevision: 3,
      ordinal: 1
    });
    await db
      .update(discordOutbox)
      .set({ nextAttemptAt: readyAt })
      .where(sql`${discordOutbox.id} IN (${first.id}, ${existingSuccessor.id})`);

    const now = new Date("2026-04-24T12:35:00.000Z");
    const claimed = await claimNextOutboxBatch(db, {
      limit: 10,
      now,
      claimDurationMs: 30_000
    });
    expect(claimed.map((row) => row.id)).toStrictEqual([first.id]);
    expect(await markOutboxFailed(db, first.id, {
      error: "permanent",
      claimToken: claimTokenOf(claimed),
      now,
      nextAttemptAt: null
    })).toBe(true);

    const futureSuccessor = await enqueueOutbox(db, {
      kind: "send_message",
      sessionId: baseSession.id,
      payload: basePayload,
      dedupeKey: "dead-letter-future-successor",
      aggregateRevision: 4,
      ordinal: 0
    });
    await db
      .update(discordOutbox)
      .set({ nextAttemptAt: readyAt })
      .where(sql`${discordOutbox.id} = ${futureSuccessor.id}`);
    expect(await claimNextOutboxBatch(db, {
      limit: 10,
      now,
      claimDurationMs: 30_000
    })).toStrictEqual([]);

    const statuses = await db
      .select({ id: discordOutbox.id, status: discordOutbox.status })
      .from(discordOutbox)
      .where(sql`${discordOutbox.id} IN (${existingSuccessor.id}, ${futureSuccessor.id})`);
    expect(new Map(statuses.map((row) => [row.id, row.status]))).toStrictEqual(new Map([
      [existingSuccessor.id, "CANCELLED"],
      [futureSuccessor.id, "CANCELLED"]
    ]));
    expect((await enqueueOutbox(db, {
      kind: "send_message",
      sessionId: baseSession.id,
      payload: basePayload,
      dedupeKey: "dead-letter-future-successor",
      aggregateRevision: 4,
      ordinal: 0
    })).skipped).toBe(true);
  });

  it("requeueFailedOutboxChains restores a dead letter chain idempotently", async () => {
    const readyAt = new Date("2026-04-24T12:30:00.000Z");
    const first = await enqueueOutbox(db, {
      kind: "send_message",
      sessionId: baseSession.id,
      payload: basePayload,
      dedupeKey: "requeue-first",
      aggregateRevision: 8,
      ordinal: 0
    });
    const successor = await enqueueOutbox(db, {
      kind: "send_message",
      sessionId: baseSession.id,
      payload: basePayload,
      dedupeKey: "requeue-successor",
      aggregateRevision: 8,
      ordinal: 1
    });
    await db
      .update(discordOutbox)
      .set({ nextAttemptAt: readyAt })
      .where(sql`${discordOutbox.id} IN (${first.id}, ${successor.id})`);
    const now = new Date("2026-04-24T12:35:00.000Z");
    const claimed = await claimNextOutboxBatch(db, {
      limit: 10,
      now,
      claimDurationMs: 30_000
    });
    await markOutboxFailed(db, first.id, {
      error: "fixed in deployment",
      claimToken: claimTokenOf(claimed),
      now,
      nextAttemptAt: null
    });

    expect(await requeueFailedOutboxChains(db, now)).toStrictEqual({
      deadLettersRequeued: 1,
      successorsRequeued: 1
    });
    expect(await requeueFailedOutboxChains(db, now)).toStrictEqual({
      deadLettersRequeued: 0,
      successorsRequeued: 0
    });
    const rows = await db
      .select({
        status: discordOutbox.status,
        attemptCount: discordOutbox.attemptCount,
        lastError: discordOutbox.lastError,
        ordinal: discordOutbox.ordinal
      })
      .from(discordOutbox)
      .where(sql`${discordOutbox.id} IN (${first.id}, ${successor.id})`)
      .orderBy(discordOutbox.ordinal);
    expect(rows.map(({ status, attemptCount, lastError }) => ({
      status,
      attemptCount,
      lastError
    }))).toStrictEqual([
      { status: "PENDING", attemptCount: 0, lastError: null },
      { status: "PENDING", attemptCount: 0, lastError: null }
    ]);
  });

  it("releaseExpiredOutboxClaims resets expired IN_FLIGHT rows", async () => {
    const { id } = await enqueueWithNextAttempt(
      "ask-dedupe-expire",
      new Date("2026-04-24T12:30:00.000Z")
    );
    await claimNextOutboxBatch(db, {
      limit: 1,
      now: new Date("2026-04-24T12:35:00.000Z"),
      claimDurationMs: 30_000
    });

    expect(await releaseExpiredOutboxClaims(
      db,
      new Date("2026-04-24T12:36:30.000Z")
    )).toBe(1);
    const [row] = await db
      .select()
      .from(discordOutbox)
      .where(sql`${discordOutbox.id} = ${id}`);
    expect({ status: row?.status, claimExpiresAt: row?.claimExpiresAt })
      .toStrictEqual({ status: "PENDING", claimExpiresAt: null });
  });

  it("findStrandedOutboxEntries surfaces FAILED and high-attempt active rows", async () => {
    const { id: failedId } = await enqueueWithNextAttempt(
      "ask-dedupe-stranded-fail",
      new Date("2026-04-24T12:30:00.000Z")
    );
    const now = new Date("2026-04-24T12:35:00.000Z");
    const failedClaim = await claimNextOutboxBatch(db, {
      limit: 1,
      now,
      claimDurationMs: 30_000
    });
    await markOutboxFailed(db, failedId, {
      error: "fatal",
      claimToken: claimTokenOf(failedClaim),
      now,
      nextAttemptAt: null
    });

    const { id: highAttemptId } = await enqueueWithNextAttempt(
      "ask-dedupe-stranded-high",
      new Date("2026-04-24T12:30:00.000Z")
    );
    await db
      .update(discordOutbox)
      .set({ attemptCount: 9 })
      .where(sql`${discordOutbox.id} = ${highAttemptId}`);

    const strandedIds = new Set(
      (await findStrandedOutboxEntries(db, 5)).map((row) => row.id)
    );
    expect(strandedIds).toStrictEqual(new Set([failedId, highAttemptId]));
  });
});
