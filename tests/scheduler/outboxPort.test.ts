import { beforeEach, describe, expect, it, vi } from "vitest";

import { reconcileOutboxClaims } from "../../src/scheduler/reconciler.js";
import { createTestAppContext } from "../testing/index.js";
import { makeOutboxEntry } from "../testing/fixtures.js";
import { buildSessionRow } from "./factories/session.js";

describe("outbox port fake", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deduplicates a non-FAILED dedupe key", async () => {
    const session = buildSessionRow({ id: "s1" });
    const ctx = createTestAppContext({ seed: { sessions: [session] } });
    const input = {
      kind: "send_message" as const,
      sessionId: session.id,
      dedupeKey: "settle-notice-s1-absent",
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
      payload: {
        kind: "send_message",
        channelId: session.channelId,
        renderer: "raw_text",
        extra: { content: "later" }
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

    expect(await reconcileOutboxClaims(ctx)).toBe(1);
    const [entry] = ctx.ports.outbox.listEntries();
    expect({ status: entry?.status, claimExpiresAt: entry?.claimExpiresAt, nextAttemptAt: entry?.nextAttemptAt })
      .toStrictEqual({ status: "PENDING", claimExpiresAt: null, nextAttemptAt: now });
  });

  it("returns exactly FAILED and high-attempt active rows as stranded", async () => {
    const session = buildSessionRow({ id: "s7" });
    const ctx = createTestAppContext({ seed: { sessions: [session] } });
    ctx.ports.outbox.seedEntry(makeOutboxEntry({ id: "failed", status: "FAILED", attemptCount: 1 }));
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

    expect((await ctx.ports.outbox.findStranded(5)).map((entry) => entry.id)).toStrictEqual([
      "failed",
      "pending-high"
    ]);
  });
});
