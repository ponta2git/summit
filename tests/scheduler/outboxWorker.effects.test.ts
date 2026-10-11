import { setImmediate } from "node:timers/promises";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OUTBOX_HEARTBEAT_MS } from "../../src/config.ts";
import { DatabaseError, InvariantViolationError } from "../../src/errors/index.ts";
import * as effectRuntime from "../../src/runtime/effect.ts";
import * as renderers from "../../src/scheduler/outboxRenderers.ts";
import { runOutboxWorkerTick } from "../../src/scheduler/outboxWorker.ts";
import { runEffect } from "../helpers/assertions.ts";
import { deferred } from "../helpers/deferred.ts";
import { createTestAppContext } from "../testing/index.ts";
import { buildSessionRow } from "../testing/sessionScenario.ts";
import { stubChannel, stubClient } from "./outboxWorker.harness.ts";

const createBatch = async (renderer = "settle_notice", count = 2) => {
  const sessions = [buildSessionRow({ id: "first", askMessageId: null }),
    buildSessionRow({ id: "second", candidateDateIso: "2026-04-17", askMessageId: null })].slice(0, count);
  const ctx = createTestAppContext({ seed: { sessions }, now: new Date("2026-04-24T12:00:00Z") });
  for (const session of sessions) {
    await ctx.ports.outbox.enqueue({ kind: "send_message", sessionId: session.id, dedupeKey: `notice-${session.id}`,
      aggregateRevision: 0, ordinal: 0, payload: { kind: "send_message", channelId: session.channelId,
        renderer, ...(renderer === "ask_body" ? { target: "askMessageId" as const } : {}),
        extra: { reason: "absent", forceSuppressMentions: true } } });
  }
  const { channel } = stubChannel();
  return { ctx, channel, client: stubClient(channel) };
};

describe("outbox Effect composition", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.clearAllTimers(); vi.useRealTimers(); });

  it("keeps the owner's Context through delivery, parallel attendance reads and heartbeat", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-04-24T12:00:00Z"));
    const Probe = Context.Reference<string>("test/outbox-owner", { defaultValue: () => "new-root" });
    const seen = { render: [] as string[], responses: [] as string[], members: [] as string[], heartbeat: [] as string[] };
    let bridgeContext = "not-in-effect";
    const settledCall = effectRuntime.settledCall;
    // Observe the Context at the external Promise boundary without changing the port behavior.
    vi.spyOn(effectRuntime, "settledCall").mockImplementation(<T>(call: () => PromiseLike<T>) =>
      Effect.flatMap(Effect.service(Probe), value => settledCall(() => { bridgeContext = value; return call(); })));
    const render = renderers.renderOutboxPayload;
    vi.spyOn(renderers, "renderOutboxPayload").mockImplementation((ctx, entry) =>
      Effect.flatMap(Effect.service(Probe), value => { seen.render.push(value); return render(ctx, entry); }));
    const { ctx, channel, client } = await createBatch("ask_body");
    const responses = ctx.ports.responses.listResponses; const members = ctx.ports.members.listMembers;
    const renew = ctx.ports.outbox.renewClaim;
    ctx.ports.responses.listResponses = id => { seen.responses.push(bridgeContext); return responses(id); };
    ctx.ports.members.listMembers = () => { seen.members.push(bridgeContext); return members(); };
    ctx.ports.outbox.renewClaim = (...args) => { seen.heartbeat.push(bridgeContext); return renew(...args); };
    const sending = deferred<void>(); const sent = deferred<{ id: string }>(); let sends = 0;
    channel.send.mockImplementation(async payload => {
      if (++sends === 2) { sending.resolve(); }
      return { ...await sent.promise, payload };
    });
    const tick = runEffect(runOutboxWorkerTick(client, ctx).pipe(Effect.provideService(Probe, "owner")));
    try { await sending.promise; await vi.advanceTimersByTimeAsync(OUTBOX_HEARTBEAT_MS); }
    finally { sent.resolve({ id: "accepted" }); await tick; }
    expect(seen).toStrictEqual({ render: ["owner", "owner"], responses: ["owner", "owner"],
      members: ["owner", "owner"], heartbeat: ["owner", "owner"] });
    expect(ctx.ports.outbox.listEntries().map(entry => entry.status)).toEqual(["DELIVERED", "DELIVERED"]);
  });

  it("rechecks stop at the send boundary after delivery preparation has finished", async () => {
    const { ctx, channel, client } = await createBatch("ask_body", 1);
    let prepared = false; let stopping = false;
    const begin = ctx.ports.outbox.beginDelivery;
    ctx.ports.outbox.beginDelivery = async (...args) => {
      const accepted = await begin(...args); prepared = accepted; return accepted;
    };
    const settledCall = effectRuntime.settledCall;
    // Model a stop during an Effect yield between preparation and the next external call.
    vi.spyOn(effectRuntime, "settledCall").mockImplementation(<T>(call: () => PromiseLike<T>) => settledCall(() => {
      if (prepared) { stopping = true; }
      return call();
    }));
    const delivered = vi.spyOn(ctx.ports.outbox, "markDelivered");
    const backfilled = vi.spyOn(ctx.ports.sessions, "backfillAskMessageId");
    const failed = vi.spyOn(ctx.ports.outbox, "markFailed");
    await runEffect(runOutboxWorkerTick(client, ctx, () => stopping));
    expect(prepared).toBe(true);
    expect(stopping).toBe(true);
    expect(channel.send).not.toHaveBeenCalled();
    expect(delivered).not.toHaveBeenCalled();
    expect(backfilled).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
    expect(ctx.ports.outbox.listEntries()[0]).toMatchObject({ status: "IN_FLIGHT", deliveredMessageId: null });
  });

  it("selects the first input failure after a later delivery has already failed", async () => {
    const { ctx, channel, client } = await createBatch();
    const firstId = ctx.ports.outbox.listEntries().find(entry => entry.sessionId === "first")!.id;
    const firstFailed = deferred<boolean>(); const secondFailed = deferred<void>();
    const firstError = new Error("first finalization failed"); const secondError = new Error("second finalization failed");
    channel.send.mockRejectedValue(new Error("Discord failed"));
    ctx.ports.outbox.markFailed = (id) => {
      if (id === firstId) { return firstFailed.promise; }
      secondFailed.resolve(); return Promise.reject(secondError);
    };
    let settled = false;
    const tick = runEffect(Effect.result(runOutboxWorkerTick(client, ctx))).then(result => { settled = true; return result; });
    try { await secondFailed.promise; await setImmediate(); expect(settled).toBe(false); }
    finally { firstFailed.reject(firstError); await tick; }
    const result = await tick;
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isSuccess(result)) { throw new Error("Expected a finalization failure."); }
    expect(result.failure).toBeInstanceOf(InvariantViolationError);
    expect(result.failure.cause).toBe(firstError);
    expect(channel.send).toHaveBeenCalledTimes(2);
  });

  it.each(["defect", "mixed"] as const)("drains sibling delivery and preserves a renderer %s without scheduling its retry", async mode => {
    const { ctx, channel, client } = await createBatch();
    const defect = new Error("renderer defect"); const failure = new DatabaseError("expected failure");
    const cause = mode === "defect" ? Cause.die(defect) : Cause.combine(Cause.fail(failure), Cause.die(defect));
    const render = renderers.renderOutboxPayload;
    vi.spyOn(renderers, "renderOutboxPayload").mockImplementation((context, entry) =>
      entry.sessionId === "first" ? Effect.failCause(cause) : render(context, entry));
    const failed = vi.spyOn(ctx.ports.outbox, "markFailed");
    const sending = deferred<void>(); const sent = deferred<{ id: string }>();
    channel.send.mockImplementation(async payload => { sending.resolve(); return { ...await sent.promise, payload }; });
    let settled = false;
    const tick = runEffect(Effect.result(runOutboxWorkerTick(client, ctx))).then(result => { settled = true; return result; });
    try { await sending.promise; await setImmediate(); expect(settled).toBe(false); }
    finally { sent.resolve({ id: "sibling-accepted" }); await tick; }
    const result = await tick;
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isSuccess(result)) { throw new Error("Expected the renderer failure."); }
    expect(result.failure).toBeInstanceOf(InvariantViolationError);
    const observed = mode === "mixed" && result.failure.cause instanceof InvariantViolationError
      ? result.failure.cause.cause : result.failure.cause;
    expect(observed).toBe(mode === "mixed" ? cause : defect);
    expect(failed).not.toHaveBeenCalled();
    expect(ctx.ports.outbox.listEntries().map(entry => entry.status)).toEqual(["IN_FLIGHT", "DELIVERED"]);
  });

  it.each(["interruption", "mixed"] as const)("propagates a later %s ahead of an earlier finalization failure", async mode => {
    const { ctx, channel, client } = await createBatch();
    const failure = new DatabaseError("concurrent delivery failure");
    const cause = mode === "mixed" ? Cause.combine(Cause.fail(failure), Cause.interrupt()) : Cause.interrupt();
    vi.spyOn(renderers, "renderOutboxPayload").mockImplementation((_context, entry) =>
      entry.sessionId === "first" ? Effect.fail(new Error("render query failed")) : Effect.failCause(cause));
    const failed = vi.spyOn(ctx.ports.outbox, "markFailed").mockRejectedValue(new Error("finalization failed"));
    const exit = await runEffect(Effect.exit(runOutboxWorkerTick(client, ctx)));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isSuccess(exit)) { throw new Error("Expected interruption."); }
    expect(Cause.hasInterrupts(exit.cause)).toBe(true);
    expect(Cause.hasFails(exit.cause)).toBe(mode === "mixed");
    expect(exit.cause.reasons.filter(Cause.isFailReason).map(reason => reason.error))
      .toEqual(mode === "mixed" ? [failure] : []);
    expect(failed).toHaveBeenCalledOnce();
    expect(channel.send).not.toHaveBeenCalled();
  });

  it("drains the other attendance query before persisting a renderer query failure", async () => {
    const { ctx, channel, client } = await createBatch("ask_body");
    ctx.ports.responses.listResponses = async () => { throw new Error("query failed"); };
    const reading = deferred<void>(); const members = deferred<Awaited<ReturnType<typeof ctx.ports.members.listMembers>>>();
    ctx.ports.members.listMembers = () => { reading.resolve(); return members.promise; };
    const failed = vi.spyOn(ctx.ports.outbox, "markFailed");
    let settled = false;
    const tick = runEffect(runOutboxWorkerTick(client, ctx)).then(result => { settled = true; return result; });
    try {
      await reading.promise; await setImmediate();
      expect(settled).toBe(false); expect(failed).not.toHaveBeenCalled();
    } finally { members.resolve([]); await tick; }
    expect(channel.send).not.toHaveBeenCalled();
    expect(ctx.ports.outbox.listEntries().map(entry => ({ status: entry.status, lastError: entry.lastError })))
      .toEqual([{ status: "PENDING", lastError: "Outbox delivery failed." },
        { status: "PENDING", lastError: "Outbox delivery failed." }]);
  });
});
