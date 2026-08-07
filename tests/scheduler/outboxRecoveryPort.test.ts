import { describe, expect, it } from "vitest";

import { reconcileOutboxClaims } from "../../src/scheduler/reconciler.js";
import { createTestAppContext } from "../testing/index.js";
import { makeOutboxEntry } from "../testing/fixtures.js";
import { buildSessionRow } from "./factories/session.js";
import { unwrapResultAsync } from "../helpers/assertions.js";

const requireClaimToken = (
  entry: { readonly claimToken: string | null }
): string => {
  if (entry.claimToken === null) {
    throw new Error("expected claimed outbox entry");
  }
  return entry.claimToken;
};

describe("outbox port fake recovery", () => {
  it("dead-letters a failed entry and cancels its ordered successors", async () => {
    const session = buildSessionRow({ id: "s-dead-letter" });
    const ctx = createTestAppContext({ seed: { sessions: [session] } });
    const payload = {
      kind: "send_message" as const,
      channelId: session.channelId,
      renderer: "settle_notice",
      extra: { reason: "absent", forceSuppressMentions: true }
    };
    await ctx.ports.outbox.enqueue({
      kind: "send_message",
      sessionId: session.id,
      dedupeKey: "dead-letter-first",
      payload,
      aggregateRevision: 3,
      ordinal: 0
    });
    await ctx.ports.outbox.enqueue({
      kind: "send_message",
      sessionId: session.id,
      dedupeKey: "dead-letter-successor",
      payload,
      aggregateRevision: 3,
      ordinal: 1
    });

    const [claimed] = await ctx.ports.outbox.claimNextBatch({
      limit: 10,
      now: ctx.clock.now(),
      claimDurationMs: 30_000
    });
    if (!claimed) {throw new Error("expected claimed outbox entry");}
    expect(await ctx.ports.outbox.markFailed(claimed.id, {
      claimToken: requireClaimToken(claimed),
      error: "permanent failure",
      now: ctx.clock.now(),
      nextAttemptAt: null
    })).toBe(true);

    expect([...ctx.ports.outbox.listEntries()]
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((entry) => entry.status)).toStrictEqual(["FAILED", "CANCELLED"]);

    const future = await ctx.ports.outbox.enqueue({
      kind: "send_message",
      sessionId: session.id,
      dedupeKey: "dead-letter-future-successor",
      payload,
      aggregateRevision: 4,
      ordinal: 0
    });
    expect(await ctx.ports.outbox.claimNextBatch({
      limit: 10,
      now: ctx.clock.now(),
      claimDurationMs: 30_000
    })).toStrictEqual([]);
    expect(ctx.ports.outbox.listEntries().find((entry) => entry.id === future.id)?.status)
      .toBe("CANCELLED");
    expect((await ctx.ports.outbox.enqueue({
      kind: "send_message",
      sessionId: session.id,
      dedupeKey: "dead-letter-future-successor",
      payload,
      aggregateRevision: 4,
      ordinal: 0
    })).skipped).toBe(true);
  });

  it("requeues a dead letter and its cancelled successors once per recovery", async () => {
    const session = buildSessionRow({ id: "s-dead-letter-recovery" });
    const ctx = createTestAppContext({ seed: { sessions: [session] } });
    const payload = {
      kind: "send_message" as const,
      channelId: session.channelId,
      renderer: "settle_notice",
      extra: { reason: "absent", forceSuppressMentions: true }
    };
    await ctx.ports.outbox.enqueue({
      kind: "send_message",
      sessionId: session.id,
      dedupeKey: "recovery-first",
      payload,
      aggregateRevision: 3,
      ordinal: 0
    });
    await ctx.ports.outbox.enqueue({
      kind: "send_message",
      sessionId: session.id,
      dedupeKey: "recovery-successor",
      payload,
      aggregateRevision: 3,
      ordinal: 1
    });
    const [claimed] = await ctx.ports.outbox.claimNextBatch({
      limit: 10,
      now: ctx.clock.now(),
      claimDurationMs: 30_000
    });
    if (!claimed) {throw new Error("expected claimed outbox entry");}
    await ctx.ports.outbox.markFailed(claimed.id, {
      claimToken: requireClaimToken(claimed),
      error: "fixed by next deployment",
      now: ctx.clock.now(),
      nextAttemptAt: null
    });

    expect(await ctx.ports.outbox.requeueFailedChains(ctx.clock.now())).toStrictEqual({
      deadLettersRequeued: 1,
      successorsRequeued: 1
    });
    expect(await ctx.ports.outbox.requeueFailedChains(ctx.clock.now())).toStrictEqual({
      deadLettersRequeued: 0,
      successorsRequeued: 0
    });
    expect(ctx.ports.outbox.listEntries().map((entry) => ({
      status: entry.status,
      attemptCount: entry.attemptCount,
      lastError: entry.lastError
    }))).toStrictEqual([
      { status: "PENDING", attemptCount: 0, lastError: null },
      { status: "PENDING", attemptCount: 0, lastError: null }
    ]);
    expect((await ctx.ports.outbox.claimNextBatch({
      limit: 10,
      now: ctx.clock.now(),
      claimDurationMs: 30_000
    })).map((entry) => entry.dedupeKey)).toStrictEqual(["recovery-first"]);
  });

  it("releases expired claims back to PENDING", async () => {
    const session = buildSessionRow({ id: "s6" });
    const now = new Date("2026-04-24T12:00:00Z");
    const ctx = createTestAppContext({ seed: { sessions: [session] }, now });
    ctx.ports.outbox.seedEntry(makeOutboxEntry({
      id: "stale-1",
      sessionId: session.id,
      dedupeKey: "stale-1",
      status: "IN_FLIGHT",
      attemptCount: 1,
      claimExpiresAt: new Date("2026-04-24T11:00:00Z"),
      nextAttemptAt: new Date("2026-04-24T11:00:00Z")
    }));

    expect(await unwrapResultAsync(reconcileOutboxClaims(ctx))).toBe(1);
    const [entry] = ctx.ports.outbox.listEntries();
    expect({
      status: entry?.status,
      claimExpiresAt: entry?.claimExpiresAt,
      nextAttemptAt: entry?.nextAttemptAt
    }).toStrictEqual({ status: "PENDING", claimExpiresAt: null, nextAttemptAt: now });
  });

  it("returns exactly FAILED and high-attempt active rows as stranded", async () => {
    const session = buildSessionRow({ id: "s7" });
    const ctx = createTestAppContext({ seed: { sessions: [session] } });
    ctx.ports.outbox.seedEntry(makeOutboxEntry({
      id: "failed",
      status: "FAILED",
      attemptCount: 1
    }));
    ctx.ports.outbox.seedEntry(makeOutboxEntry({
      id: "pending-high",
      dedupeKey: "pending-high",
      status: "PENDING",
      attemptCount: 5
    }));
    ctx.ports.outbox.seedEntry(makeOutboxEntry({
      id: "pending-low",
      dedupeKey: "pending-low",
      status: "PENDING",
      attemptCount: 4
    }));

    expect((await ctx.ports.outbox.findStranded(5)).map((entry) => entry.id))
      .toStrictEqual(["failed", "pending-high"]);
  });
});
