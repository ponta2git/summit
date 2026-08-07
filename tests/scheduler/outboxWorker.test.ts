import { ChannelType } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import {
  OUTBOX_BACKOFF_MS_SEQUENCE,
  OUTBOX_MAX_ATTEMPTS
} from "../../src/config.js";
import {
  computeOutboxBackoff,
  runOutboxWorkerTick
} from "../../src/scheduler/outboxWorker.js";
import { deferred } from "../helpers/deferred.js";
import { createTestAppContext } from "../testing/index.js";
import { buildSessionRow } from "./factories/session.js";
import { stubChannel, stubClient } from "./outboxWorker.harness.js";

describe("outbox worker delivery", () => {
  it("starts claimed deliveries concurrently within one batch", async () => {
    const session = buildSessionRow({ id: "s3-parallel" });
    const ctx = createTestAppContext({
      seed: { sessions: [session] },
      now: new Date("2026-04-24T12:00:00Z")
    });
    for (const suffix of ["a", "b"]) {
      await ctx.ports.outbox.enqueue({
        kind: "send_message",
        sessionId: session.id,
        dedupeKey: `raw-${session.id}-${suffix}`,
        payload: {
          kind: "send_message",
          channelId: session.channelId,
          renderer: "raw_text",
          extra: { content: suffix }
        }
      });
    }

    const firstSendDone = deferred<{ readonly id: string }>();
    const secondSendStarted = deferred<void>();
    let sendCount = 0;
    const channel = {
      type: ChannelType.GuildText,
      isSendable: () => true,
      send: vi.fn(() => {
        sendCount += 1;
        if (sendCount === 1) {
          return firstSendDone.promise;
        }
        secondSendStarted.resolve();
        return Promise.resolve({ id: "posted-2" });
      })
    };

    const tick = runOutboxWorkerTick(stubClient(channel), ctx);
    await secondSendStarted.promise;
    expect(channel.send).toHaveBeenCalledTimes(2);
    firstSendDone.resolve({ id: "posted-1" });
    await tick;

    expect(ctx.ports.outbox.listEntries().map((entry) => entry.status)).toStrictEqual([
      "DELIVERED",
      "DELIVERED"
    ]);
  });

  it("delivers a row and backfills a null ask message id", async () => {
    const session = buildSessionRow({ id: "s3", status: "ASKING", askMessageId: null });
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
    const { channel, sentMessages } = stubChannel();

    await runOutboxWorkerTick(stubClient(channel), ctx);

    const [entry] = ctx.ports.outbox.listEntries();
    expect({ status: entry?.status, deliveredMessageId: entry?.deliveredMessageId })
      .toStrictEqual({ status: "DELIVERED", deliveredMessageId: "posted-1" });
    expect((await ctx.ports.sessions.findSessionById(session.id))?.askMessageId).toBe("posted-1");
    expect(sentMessages).toStrictEqual([{ id: "posted-1", payload: { content: "hello" } }]);
  });

  it("does not overwrite a non-null ask message id", async () => {
    const session = buildSessionRow({
      id: "s3b",
      status: "ASKING",
      askMessageId: "reconciler-posted-99"
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

    expect(ctx.ports.outbox.listEntries()[0]?.status).toBe("DELIVERED");
    expect((await ctx.ports.sessions.findSessionById(session.id))?.askMessageId)
      .toBe("reconciler-posted-99");
  });
});

describe("outbox worker retry policy", () => {
  it("marks a failed delivery PENDING with the first backoff", async () => {
    const now = new Date("2026-04-24T12:00:00Z");
    const session = buildSessionRow({ id: "s4" });
    const ctx = createTestAppContext({ seed: { sessions: [session] }, now });
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
    expect({
      status: entry?.status,
      attemptCount: entry?.attemptCount,
      lastError: entry?.lastError,
      nextAttemptAt: entry?.nextAttemptAt
    }).toStrictEqual({
      status: "PENDING",
      attemptCount: 1,
      lastError: "Discord API failure",
      nextAttemptAt: new Date(now.getTime() + (OUTBOX_BACKOFF_MS_SEQUENCE[0] ?? 0))
    });
  });

  it("uses every configured delay, caps, then dead-letters", () => {
    const now = new Date("2026-04-24T12:00:00Z");

    expect(
      OUTBOX_BACKOFF_MS_SEQUENCE.map((_, index) =>
        computeOutboxBackoff(index + 1, now)?.getTime()
      )
    ).toStrictEqual(OUTBOX_BACKOFF_MS_SEQUENCE.map((delay) => now.getTime() + delay));
    expect(
      computeOutboxBackoff(OUTBOX_BACKOFF_MS_SEQUENCE.length + 1, now)?.getTime()
    ).toBe(now.getTime() + (OUTBOX_BACKOFF_MS_SEQUENCE.at(-1) ?? 0));
    expect(computeOutboxBackoff(OUTBOX_MAX_ATTEMPTS, now)).toBeNull();
  });
});
