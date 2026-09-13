import { ChannelType } from "discord.js";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";

import {
  computeOutboxBackoff,
  runOutboxWorkerTick
} from "../../src/scheduler/outboxWorker.js";
import { deferred } from "../helpers/deferred.js";
import { createTestAppContext } from "../testing/index.js";
import { buildSessionRow } from "../testing/sessionScenario.ts";
import { stubChannel, stubClient } from "./outboxWorker.harness.js";

describe("outbox worker delivery", () => {
  it("waits for the rest of a batch when one delivery cannot persist its failure", async () => {
    const sessions = [buildSessionRow({ id: "failed" }), buildSessionRow({ id: "waiting", candidateDateIso: "2026-04-17" })];
    const ctx = createTestAppContext({ seed: { sessions } });
    for (const session of sessions) {
      await ctx.ports.outbox.enqueue({ kind: "send_message", sessionId: session.id, dedupeKey: `notice-${session.id}`,
        aggregateRevision: 0, ordinal: 0, payload: { kind: "send_message", channelId: session.channelId,
          renderer: "settle_notice", extra: { reason: "absent", forceSuppressMentions: true } } });
    }
    const completion = deferred<{ id: string }>(); const failed = deferred<void>();
    const { channel } = stubChannel();
    channel.send.mockRejectedValueOnce(new Error("Discord failed")).mockImplementationOnce(async body => ({ ...await completion.promise, payload: body }));
    ctx.ports.outbox.markFailed = async () => { failed.resolve(); throw new Error("Database failed"); };
    let finished = false;
    const tick = Promise.resolve(runOutboxWorkerTick(stubClient(channel), ctx)).then(result => { finished = true; return result; });
    await failed.promise; await setImmediate();
    expect(finished).toBe(false);
    completion.resolve({ id: "accepted" }); const result = await tick;
    expect(result.isErr()).toBe(true);
    expect(ctx.ports.outbox.listEntries().filter(entry => entry.status === "DELIVERED")).toHaveLength(1);
  });
  it("starts claimed deliveries concurrently within one batch", async () => {
    const sessions = [
      buildSessionRow({ id: "s3-parallel-a" }),
      buildSessionRow({ id: "s3-parallel-b", weekKey: "2026-W18" })
    ];
    const ctx = createTestAppContext({
      seed: { sessions },
      now: new Date("2026-04-24T12:00:00Z")
    });
    for (const [index, session] of sessions.entries()) {
      const suffix = index === 0 ? "a" : "b";
      await ctx.ports.outbox.enqueue({
        kind: "send_message",
        sessionId: session.id,
        dedupeKey: `settle-${session.id}-${suffix}`,
        aggregateRevision: 0,
        ordinal: 0,
        payload: {
          kind: "send_message",
          channelId: session.channelId,
          renderer: "settle_notice",
          extra: { reason: "absent", forceSuppressMentions: true }
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
      aggregateRevision: 0,
      ordinal: 0,
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
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]?.payload).toMatchObject({
      content: expect.stringContaining("開催候補日: 2026-04-24(金)"),
      components: expect.any(Array)
    });
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
      aggregateRevision: 0,
      ordinal: 0,
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
      aggregateRevision: 0,
      ordinal: 0,
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
      lastError: "Outbox delivery failed.",
      nextAttemptAt: new Date("2026-04-24T12:00:01.000Z")
    });
  });

  it("stores a fixed failure summary instead of external error text", async () => {
    const session = buildSessionRow({ id: "safe-diagnostics" });
    const ctx = createTestAppContext({ seed: { sessions: [session] } });
    await ctx.ports.outbox.enqueue({ kind: "send_message", sessionId: session.id, dedupeKey: "safe-diagnostics",
      aggregateRevision: 0, ordinal: 0, payload: { kind: "send_message", channelId: session.channelId, renderer: "ask_body" } });
    const { channel } = stubChannel(); channel.send.mockRejectedValue(new Error("postgres://private:dummy-password@localhost/database"));
    await runOutboxWorkerTick(stubClient(channel), ctx);
    expect(ctx.ports.outbox.listEntries()[0]?.lastError).toBe("Outbox delivery failed.");
  });

  it("uses the complete retry sequence, caps, then dead-letters", () => {
    const now = new Date("2026-04-24T12:00:00Z");

    expect(Array.from({ length: 9 }, (_, index) =>
      computeOutboxBackoff(index + 1, now)?.toISOString()
    )).toStrictEqual([
      "2026-04-24T12:00:01.000Z",
      "2026-04-24T12:00:02.000Z",
      "2026-04-24T12:00:05.000Z",
      "2026-04-24T12:00:15.000Z",
      "2026-04-24T12:01:00.000Z",
      "2026-04-24T12:05:00.000Z",
      "2026-04-24T12:15:00.000Z",
      "2026-04-24T12:15:00.000Z",
      "2026-04-24T12:15:00.000Z"
    ]);
    expect(computeOutboxBackoff(10, now)).toBeNull();
  });
});
