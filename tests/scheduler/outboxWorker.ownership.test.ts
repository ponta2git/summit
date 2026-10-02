import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OUTBOX_CLAIM_DURATION_MS, OUTBOX_HEARTBEAT_MS } from "../../src/config.ts";
import { runOutboxWorkerTick } from "../../src/scheduler/outboxWorker.ts";
import { runEffect } from "../helpers/assertions.ts";
import { deferred } from "../helpers/deferred.ts";
import { createTestAppContext } from "../testing/index.ts";
import { buildSessionRow } from "../testing/sessionScenario.ts";
import { stubChannel, stubClient } from "./outboxWorker.harness.ts";

const createWorker = async () => {
  const session = buildSessionRow({ id: "lease-owner", status: "ASKING", askMessageId: null });
  const context = createTestAppContext({ seed: { sessions: [session] }, now: () => new Date() });
  await context.ports.outbox.enqueue({ kind: "send_message", sessionId: session.id, dedupeKey: "lease-owner",
    aggregateRevision: 0, ordinal: 0,
    payload: { kind: "send_message", channelId: session.channelId, renderer: "ask_body", target: "askMessageId" } });
  const { channel } = stubChannel();
  return { context, channel, session };
};

describe("outbox delivery ownership", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-04-24T12:00:00Z")); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it("renews slow sends through their final commit and prevents an expired-claim replay", async () => {
    const { context, channel } = await createWorker();
    const sending = deferred<void>(); const sent = deferred<{ id: string }>();
    channel.send.mockImplementationOnce(async payload => { sending.resolve(); return { ...await sent.promise, payload }; });
    const tick = runEffect(runOutboxWorkerTick(stubClient(channel), context));
    try {
      await sending.promise;
      await vi.advanceTimersByTimeAsync(OUTBOX_CLAIM_DURATION_MS + 1_000);
      expect(await context.ports.outbox.releaseExpiredClaims(context.clock.now())).toBe(0);
      expect(await context.ports.outbox.claimNextBatch({ limit: 1, now: context.clock.now(), claimDurationMs: OUTBOX_CLAIM_DURATION_MS })).toEqual([]);
    } finally { sent.resolve({ id: "accepted-after-original-expiry" }); await tick; }
    expect(context.ports.outbox.listEntries()[0]).toMatchObject({ status: "DELIVERED", attemptCount: 1,
      deliveredMessageId: "accepted-after-original-expiry" });
    const renewals = context.ports.outbox.calls.filter(call => call.name === "renewClaim").length;
    expect(renewals).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(OUTBOX_HEARTBEAT_MS * 2);
    expect(context.ports.outbox.calls.filter(call => call.name === "renewClaim")).toHaveLength(renewals);
  });

  it.each(["render", "channel", "begin"] as const)("does not send when ownership is lost during %s", async phase => {
    const { context, channel } = await createWorker();
    const entered = deferred<void>(); const released = deferred<void>();
    const pause = async <T>(value: T): Promise<T> => { entered.resolve(); await released.promise; return value; };
    if (phase === "render") {
      const find = context.ports.sessions.findSessionById;
      context.ports.sessions.findSessionById = async id => pause(await find(id));
    }
    if (phase === "begin") {
      const begin = context.ports.outbox.beginDelivery;
      context.ports.outbox.beginDelivery = async (...args) => pause(await begin(...args));
    }
    context.ports.outbox.renewClaim = async () => false;
    const client = stubClient(channel, async () => phase === "channel" ? pause(channel) : channel);
    const tick = runEffect(runOutboxWorkerTick(client, context));
    try { await entered.promise; await vi.advanceTimersByTimeAsync(OUTBOX_HEARTBEAT_MS); }
    finally { released.resolve(); await tick; }
    expect(channel.send).not.toHaveBeenCalled();
    expect(client.channels.fetch).toHaveBeenCalledTimes(phase === "render" ? 0 : 1);
    expect(context.ports.outbox.listEntries()[0]).toMatchObject({ status: "IN_FLIGHT", deliveredMessageId: null });
  });

  it("records a send already started before a synchronous renewal failure", async () => {
    const { context, channel } = await createWorker();
    const sending = deferred<void>(); const sent = deferred<{ id: string }>();
    channel.send.mockImplementationOnce(async payload => { sending.resolve(); return { ...await sent.promise, payload }; });
    context.ports.outbox.renewClaim = () => { throw new Error("renewal unavailable"); };
    const tick = runEffect(runOutboxWorkerTick(stubClient(channel), context));
    try { await sending.promise; await vi.advanceTimersByTimeAsync(OUTBOX_HEARTBEAT_MS); }
    finally { sent.resolve({ id: "already-accepted" }); await tick; }
    expect(context.ports.outbox.listEntries()[0]).toMatchObject({ status: "DELIVERED", deliveredMessageId: "already-accepted" });
    expect(channel.send).toHaveBeenCalledOnce();
  });

  it("retains a pending renewal after delivery finishes until that database operation settles", async () => {
    const { context, channel } = await createWorker();
    const sending = deferred<void>(); const sent = deferred<{ id: string }>(); const renewed = deferred<boolean>();
    channel.send.mockImplementationOnce(async payload => { sending.resolve(); return { ...await sent.promise, payload }; });
    context.ports.outbox.renewClaim = vi.fn(() => renewed.promise);
    let finished = false;
    const tick = Promise.resolve(runEffect(runOutboxWorkerTick(stubClient(channel), context)))
      .then(() => { finished = true; return undefined; });
    try {
      await sending.promise; await vi.advanceTimersByTimeAsync(OUTBOX_HEARTBEAT_MS);
      sent.resolve({ id: "delivered" }); await vi.advanceTimersByTimeAsync(0);
      expect(context.ports.outbox.listEntries()[0]?.status).toBe("DELIVERED");
      expect(finished).toBe(false);
    } finally { sent.resolve({ id: "delivered" }); renewed.resolve(true); await tick; }
    expect(finished).toBe(true);
  });

  it("reuses the persisted identity as the Discord nonce after an uncertain send", async () => {
    const { context, channel } = await createWorker();
    const client = stubClient(channel);
    channel.send.mockRejectedValueOnce(new Error("response lost"));
    await runEffect(runOutboxWorkerTick(client, context));
    const first = channel.send.mock.calls[0]?.[0];
    expect(first?.enforceNonce).toBe(true);
    expect(first?.nonce).toEqual(expect.stringMatching(/^[\w-]{25}$/));
    await vi.advanceTimersByTimeAsync(1_000);
    await runEffect(runOutboxWorkerTick(client, context));
    expect(channel.send.mock.calls[1]?.[0]).toStrictEqual(first);
    expect(context.ports.outbox.listEntries()[0]).toMatchObject({ status: "DELIVERED", attemptCount: 2 });
  });
});
