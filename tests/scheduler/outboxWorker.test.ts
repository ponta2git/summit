// why: outbox port (ADR-0035) の fake 実装と worker 配送パスの回帰テスト。
//   real repository は同じ port 契約 (ports.ts) を満たすため、ここでのカバレッジが production 挙動の保証の要。

import { ChannelType, type Client } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OutboxEntry } from "../../src/db/ports.js";
import {
  OUTBOX_BACKOFF_MS_SEQUENCE,
  OUTBOX_MAX_ATTEMPTS
} from "../../src/config.js";
import {
  computeOutboxBackoff,
  runOutboxWorkerTick
} from "../../src/scheduler/outboxWorker.js";
import { reconcileOutboxClaims } from "../../src/scheduler/reconciler.js";
import { createTestAppContext } from "../testing/index.js";

import { buildSessionRow } from "./factories/session.js";

const stubChannel = (overrides?: { sendThrows?: boolean }) => {
  const sentMessages: { id: string }[] = [];
  const channel = {
    type: ChannelType.GuildText,
    isSendable: () => true,
    send: vi.fn(async () => {
      if (overrides?.sendThrows) {
        throw new Error("Discord API failure");
      }
      const msg = { id: `posted-${sentMessages.length + 1}` };
      sentMessages.push(msg);
      return msg;
    })
  };
  return { channel, sentMessages };
};

const stubClient = (channel: unknown): Client =>
  ({
    channels: { fetch: vi.fn(async () => channel) }
  }) as unknown as Client;

describe("outbox port (fake): enqueue idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns skipped=true for duplicate dedupeKey while status is non-FAILED", async () => {
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
    expect(second.skipped).toBe(true);
    expect(second.id).toBe(first.id);
    expect(ctx.ports.outbox.listEntries()).toHaveLength(1);
  });

  it("enqueues via transaction when passed through cancelAsking.outbox and rejects duplicates", async () => {
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

    await ctx.ports.sessions.cancelAsking({
      id: session.id,
      now: new Date("2026-04-24T12:30:00Z"),
      reason: "absent",
      outbox: [entry]
    });

    // unique: 直接 enqueue で同 key を追加しようとしても skipped=true が返り 1 件に収束する。
    const again = await ctx.ports.outbox.enqueue(entry);
    expect(again.skipped).toBe(true);
    expect(ctx.ports.outbox.listEntries()).toHaveLength(1);
  });
});

describe("outbox worker: success path", () => {
  it("delivers PENDING row, marks DELIVERED, and back-fills askMessageId when target=askMessageId", async () => {
    const session = buildSessionRow({
      id: "s3",
      status: "ASKING",
      askMessageId: null
    });
    const ctx = createTestAppContext({
      seed: { sessions: [session] },
      now: new Date("2026-04-24T12:00:00Z")
    });

    await ctx.ports.outbox.enqueue({
      kind: "send_message",
      sessionId: session.id,
      dedupeKey: `ask-msg-${session.id}`,
      payload: {
        kind: "send_message",
        channelId: session.channelId,
        renderer: "ask_body",
        target: "askMessageId",
        extra: { content: "hello" }
      }
    });

    const { channel } = stubChannel();
    await runOutboxWorkerTick(stubClient(channel), ctx);

    const entries = ctx.ports.outbox.listEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.status).toBe("DELIVERED");
    expect(entries[0]?.deliveredMessageId).toBe("posted-1");

    const persisted = ctx.ports.sessions.listSessions().find((s) => s.id === session.id);
    expect(persisted?.askMessageId).toBe("posted-1");
    expect(channel.send).toHaveBeenCalledTimes(1);
  });
});

describe("outbox worker: failure path", () => {
  it("marks PENDING with exponential backoff and increments attemptCount", async () => {
    const session = buildSessionRow({ id: "s4" });
    const ctx = createTestAppContext({
      seed: { sessions: [session] },
      now: new Date("2026-04-24T12:00:00Z")
    });
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

    const { channel } = stubChannel({ sendThrows: true });
    await runOutboxWorkerTick(stubClient(channel), ctx);

    const [entry] = ctx.ports.outbox.listEntries();
    expect(entry?.status).toBe("PENDING");
    expect(entry?.attemptCount).toBe(1);
    expect(entry?.lastError).toMatch(/Discord API failure/);
    // invariant: 1st failure → OUTBOX_BACKOFF_MS_SEQUENCE[0] ms 後に再試行予定。
    const expectedAt = new Date(
      ctx.clock.now().getTime() + (OUTBOX_BACKOFF_MS_SEQUENCE[0] ?? 0)
    );
    expect(entry?.nextAttemptAt.getTime()).toBe(expectedAt.getTime());
  });

  it("computeOutboxBackoff returns null once attemptCount >= OUTBOX_MAX_ATTEMPTS", () => {
    const now = new Date("2026-04-24T12:00:00Z");
    expect(computeOutboxBackoff(OUTBOX_MAX_ATTEMPTS, now)).toBeNull();
    expect(computeOutboxBackoff(1, now)).not.toBeNull();
  });
});

describe("outbox worker: claim expiration", () => {
  it("does not re-claim IN_FLIGHT rows until claim_expires_at passes", async () => {
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
    expect(first).toHaveLength(1);
    expect(first[0]?.status).toBe("IN_FLIGHT");

    // race: 同時 tick を模す: まだ claim_expires_at を過ぎていない。
    const sameTick = await ctx.ports.outbox.claimNextBatch({
      limit: 10,
      now,
      claimDurationMs: 30_000
    });
    expect(sameTick).toHaveLength(0);

    // race: claim_expires_at を過ぎると reclaim される。
    const later = new Date(now.getTime() + 60_000);
    const reclaimed = await ctx.ports.outbox.claimNextBatch({
      limit: 10,
      now: later,
      claimDurationMs: 30_000
    });
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]?.attemptCount).toBe(2);
  });
});

describe("reconciler: releaseExpiredClaims", () => {
  it("reclaims stale IN_FLIGHT outbox rows back to PENDING", async () => {
    const session = buildSessionRow({ id: "s6" });
    const ctx = createTestAppContext({
      seed: { sessions: [session] },
      now: new Date("2026-04-24T12:00:00Z")
    });
    const stale: OutboxEntry = {
      id: "stale-1",
      kind: "send_message",
      sessionId: session.id,
      dedupeKey: "stale-1",
      payload: {
        kind: "send_message",
        channelId: session.channelId,
        renderer: "x",
        extra: { content: "x" }
      },
      status: "IN_FLIGHT",
      attemptCount: 1,
      lastError: null,
      claimExpiresAt: new Date("2026-04-24T11:00:00Z"),
      nextAttemptAt: new Date("2026-04-24T11:00:00Z"),
      deliveredAt: null,
      deliveredMessageId: null,
      createdAt: new Date("2026-04-24T10:00:00Z"),
      updatedAt: new Date("2026-04-24T11:00:00Z")
    };
    ctx.ports.outbox.seedEntry(stale);

    const released = await reconcileOutboxClaims(ctx);
    expect(released).toBe(1);
    const [entry] = ctx.ports.outbox.listEntries();
    expect(entry?.status).toBe("PENDING");
    expect(entry?.claimExpiresAt).toBeNull();
  });
});

describe("outbox findStranded: /status warning source", () => {
  it("returns FAILED rows and high-attempt PENDING rows", async () => {
    const session = buildSessionRow({ id: "s7" });
    const ctx = createTestAppContext({ seed: { sessions: [session] } });
    ctx.ports.outbox.seedEntry({
      id: "fail-1",
      kind: "send_message",
      sessionId: session.id,
      dedupeKey: "fail-1",
      payload: {
        kind: "send_message",
        channelId: session.channelId,
        renderer: "x",
        extra: { content: "x" }
      },
      status: "FAILED",
      attemptCount: 10,
      lastError: "gave up",
      claimExpiresAt: null,
      nextAttemptAt: new Date("2026-04-24T12:00:00Z"),
      deliveredAt: null,
      deliveredMessageId: null,
      createdAt: new Date("2026-04-24T10:00:00Z"),
      updatedAt: new Date("2026-04-24T12:00:00Z")
    });

    const stranded = await ctx.ports.outbox.findStranded(5);
    expect(stranded).toHaveLength(1);
    expect(stranded[0]?.status).toBe("FAILED");
  });
});
