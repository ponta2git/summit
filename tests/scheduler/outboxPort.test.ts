import { describe, expect, it } from "vitest";

import { createTestAppContext } from "../testing/index.js";
import { buildSessionRow } from "./factories/session.js";

describe("outbox port fake", () => {
  const requireClaimToken = (entry: { readonly claimToken: string | null }): string => {
    if (entry.claimToken === null) {
      throw new Error("expected claimed outbox entry");
    }
    return entry.claimToken;
  };

  it("deduplicates a key regardless of terminal status", async () => {
    const session = buildSessionRow({ id: "s1" });
    const ctx = createTestAppContext({ seed: { sessions: [session] } });
    const input = {
      kind: "send_message" as const,
      sessionId: session.id,
      dedupeKey: "settle-notice-s1-absent",
      aggregateRevision: 0,
      ordinal: 0,
      payload: {
        kind: "send_message" as const,
        channelId: session.channelId,
        renderer: "settle_notice",
        extra: { content: "hi" }
      }
    };

    const first = await ctx.ports.outbox.enqueue(input);
    const second = await ctx.ports.outbox.enqueue(input);

    expect(first.skipped).toBe(false);
    expect(second).toStrictEqual({ id: first.id, skipped: true });
    expect(ctx.ports.outbox.listEntries().map((entry) => entry.dedupeKey)).toStrictEqual([
      "settle-notice-s1-absent"
    ]);
  });

  it("enqueues a transition outbox row once", async () => {
    const session = buildSessionRow({ id: "s2", status: "ASKING" });
    const ctx = createTestAppContext({ seed: { sessions: [session] } });
    const entry = {
      kind: "send_message" as const,
      sessionId: session.id,
      dedupeKey: `settle-notice-${session.id}-absent`,
      aggregateRevision: 1,
      ordinal: 0,
      payload: {
        kind: "send_message" as const,
        channelId: session.channelId,
        renderer: "settle_notice",
        extra: { content: "hi" }
      }
    };

    const cancelled = await ctx.ports.sessions.cancelAsking({
      id: session.id,
      now: new Date("2026-04-24T12:30:00Z"),
      reason: "absent",
      outbox: [entry]
    });
    const duplicate = await ctx.ports.outbox.enqueue(entry);

    expect(cancelled?.status).toBe("CANCELLED");
    expect(duplicate.skipped).toBe(true);
    expect(ctx.ports.outbox.listEntries()).toHaveLength(1);
  });

  it("returns the earliest pending retry or in-flight expiry", async () => {
    const now = new Date("2026-04-24T12:00:00.000Z");
    const session = buildSessionRow({ id: "s-dispatch-at" });
    const ctx = createTestAppContext({ seed: { sessions: [session] }, now });
    await ctx.ports.outbox.enqueue({
      kind: "send_message",
      sessionId: session.id,
      dedupeKey: "pending-later",
      aggregateRevision: 0,
      ordinal: 0,
      payload: {
        kind: "send_message",
        channelId: session.channelId,
        renderer: "settle_notice",
        extra: { reason: "absent", forceSuppressMentions: true }
      }
    });
    const [pending] = ctx.ports.outbox.listEntries();
    if (!pending) {
      throw new Error("expected seeded outbox entry");
    }
    ctx.ports.outbox.seedEntry({
      ...pending,
      id: "in-flight-earlier",
      dedupeKey: "in-flight-earlier",
      status: "IN_FLIGHT",
      claimExpiresAt: new Date(now.getTime() - 1),
      nextAttemptAt: new Date(now.getTime() + 300_000)
    });

    expect(await ctx.ports.outbox.getNextDispatchAt(now)).toStrictEqual(
      new Date(now.getTime() - 1)
    );
  });

  it("returns null when no dispatchable rows exist", async () => {
    const ctx = createTestAppContext();
    expect(await ctx.ports.outbox.getNextDispatchAt(ctx.clock.now())).toBeNull();
  });

  it("does not reclaim an in-flight row before expiry, then reclaims at the boundary", async () => {
    const session = buildSessionRow({ id: "s5" });
    const ctx = createTestAppContext({ seed: { sessions: [session] } });
    await ctx.ports.outbox.enqueue({
      kind: "send_message",
      sessionId: session.id,
      dedupeKey: `ask-msg-${session.id}`,
      aggregateRevision: 0,
      ordinal: 0,
      payload: {
        kind: "send_message",
        channelId: session.channelId,
        renderer: "ask_body",
        extra: { content: "x" }
      }
    });
    const now = ctx.clock.now();

    const first = await ctx.ports.outbox.claimNextBatch({
      limit: 10,
      now,
      claimDurationMs: 30_000
    });
    const beforeExpiry = await ctx.ports.outbox.claimNextBatch({
      limit: 10,
      now: new Date(now.getTime() + 29_999),
      claimDurationMs: 30_000
    });
    const atExpiry = await ctx.ports.outbox.claimNextBatch({
      limit: 10,
      now: new Date(now.getTime() + 30_000),
      claimDurationMs: 30_000
    });

    expect(first.map((entry) => ({ status: entry.status, attemptCount: entry.attemptCount })))
      .toStrictEqual([{ status: "IN_FLIGHT", attemptCount: 1 }]);
    expect(beforeExpiry).toStrictEqual([]);
    expect(atExpiry.map((entry) => ({ status: entry.status, attemptCount: entry.attemptCount })))
      .toStrictEqual([{ status: "IN_FLIGHT", attemptCount: 2 }]);
  });

  it("claims one session's entries in aggregate revision and ordinal order", async () => {
    const session = buildSessionRow({ id: "s-ordered" });
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
      dedupeKey: "ordered-second",
      payload,
      aggregateRevision: 2,
      ordinal: 1
    });
    await ctx.ports.outbox.enqueue({
      kind: "send_message",
      sessionId: session.id,
      dedupeKey: "ordered-first",
      payload,
      aggregateRevision: 2,
      ordinal: 0
    });

    const firstBatch = await ctx.ports.outbox.claimNextBatch({
      limit: 10,
      now: ctx.clock.now(),
      claimDurationMs: 30_000
    });
    expect(firstBatch.map((entry) => entry.dedupeKey)).toStrictEqual(["ordered-first"]);

    const first = firstBatch[0];
    if (!first) {
      throw new Error("expected first ordered entry");
    }
    await ctx.ports.outbox.markDelivered(first.id, {
      claimToken: requireClaimToken(first),
      deliveredMessageId: null,
      now: ctx.clock.now()
    });

    const secondBatch = await ctx.ports.outbox.claimNextBatch({
      limit: 10,
      now: ctx.clock.now(),
      claimDurationMs: 30_000
    });
    expect(secondBatch.map((entry) => entry.dedupeKey)).toStrictEqual(["ordered-second"]);
  });

  it("rejects two intents assigned to the same Session order", async () => {
    const session = buildSessionRow({ id: "s-order-conflict" });
    const ctx = createTestAppContext({ seed: { sessions: [session] } });
    const base = {
      kind: "send_message" as const,
      sessionId: session.id,
      aggregateRevision: 2,
      ordinal: 0,
      payload: {
        kind: "send_message" as const,
        channelId: session.channelId,
        renderer: "settle_notice",
        extra: { reason: "absent", forceSuppressMentions: true }
      }
    };
    await ctx.ports.outbox.enqueue({ ...base, dedupeKey: "order-owner" });

    await expect(ctx.ports.outbox.enqueue({ ...base, dedupeKey: "order-conflict" }))
      .rejects.toThrow("duplicate outbox Session order");
  });

  it("rejects completion from an expired claim after the row is reclaimed", async () => {
    const session = buildSessionRow({ id: "s-fenced" });
    const now = new Date("2026-04-24T12:00:00.000Z");
    const ctx = createTestAppContext({ seed: { sessions: [session] }, now });
    await ctx.ports.outbox.enqueue({
      kind: "send_message",
      sessionId: session.id,
      dedupeKey: "claim-fenced",
      aggregateRevision: 0,
      ordinal: 0,
      payload: {
        kind: "send_message",
        channelId: session.channelId,
        renderer: "settle_notice",
        extra: { reason: "absent", forceSuppressMentions: true }
      }
    });

    const [expiredClaim] = await ctx.ports.outbox.claimNextBatch({
      limit: 1,
      now,
      claimDurationMs: 30_000
    });
    const [currentClaim] = await ctx.ports.outbox.claimNextBatch({
      limit: 1,
      now: new Date(now.getTime() + 30_000),
      claimDurationMs: 30_000
    });
    if (!expiredClaim || !currentClaim) {
      throw new Error("expected reclaimed outbox entry");
    }

    expect(requireClaimToken(currentClaim)).not.toBe(requireClaimToken(expiredClaim));
    expect(await ctx.ports.outbox.markDelivered(expiredClaim.id, {
      claimToken: requireClaimToken(expiredClaim),
      deliveredMessageId: null,
      now: new Date(now.getTime() + 30_001)
    })).toBe(false);
    expect(await ctx.ports.outbox.markDelivered(currentClaim.id, {
      claimToken: requireClaimToken(currentClaim),
      deliveredMessageId: null,
      now: new Date(now.getTime() + 30_001)
    })).toBe(true);
  });

});
