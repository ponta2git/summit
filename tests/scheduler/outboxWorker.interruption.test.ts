import { setImmediate } from "node:timers/promises";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { describe, expect, it, vi } from "vitest";
import { runOutboxWorkerTick } from "../../src/notifications/delivery/composition.attendance.ts";
import { deferred } from "../helpers/deferred.ts";
import { createTestAppContext } from "../testing/index.ts";
import { buildSessionRow } from "../testing/sessionScenario.ts";
import { stubChannel, stubClient } from "./outboxWorker.harness.ts";

const createWorker = async () => {
  const session = buildSessionRow({ id: "interrupted-owner", status: "ASKING", askMessageId: null });
  const ctx = createTestAppContext({ seed: { sessions: [session] }, now: new Date("2026-04-24T12:00:00Z") });
  await ctx.ports.outbox.enqueue({ kind: "send_message", sessionId: session.id, dedupeKey: "interrupted-owner",
    aggregateRevision: 0, ordinal: 0,
    payload: { kind: "send_message", channelId: session.channelId, renderer: "ask_body", target: "askMessageId" } });
  const { channel } = stubChannel();
  return { ctx, channel, session };
};

describe("outbox fiber interruption", () => {
  it.each(["render", "channel", "begin"] as const)("drains %s I/O after interruption without starting a send or recording a retry", async phase => {
    const { ctx, channel, session } = await createWorker();
    const entered = deferred<void>(); const released = deferred<void>();
    const pause = async <T>(value: T): Promise<T> => { entered.resolve(); await released.promise; return value; };
    if (phase === "render") {
      const find = ctx.ports.sessions.findSessionById;
      ctx.ports.sessions.findSessionById = async id => pause(await find(id));
    }
    if (phase === "begin") {
      const begin = ctx.ports.outbox.beginDelivery;
      ctx.ports.outbox.beginDelivery = async (...args) => pause(await begin(...args));
    }
    const failed = vi.spyOn(ctx.ports.outbox, "markFailed");
    const client = stubClient(channel, async () => phase === "channel" ? pause(channel) : channel);
    const controller = new AbortController(); let settled = false;
    const tick = Effect.runPromiseExit(runOutboxWorkerTick(client, ctx), { signal: controller.signal })
      .then(exit => { settled = true; return exit; });
    try {
      await entered.promise; controller.abort(); await setImmediate();
      expect(settled).toBe(false);
    } finally { released.resolve(); await tick; }
    const exit = await tick;
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isSuccess(exit)) { throw new Error("Expected interruption."); }
    expect(Cause.hasInterrupts(exit.cause)).toBe(true);
    expect(channel.send).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
    expect((await ctx.ports.sessions.findSessionById(session.id))?.askMessageId).toBeNull();
    expect(ctx.ports.outbox.listEntries()[0]).toMatchObject({ status: "IN_FLIGHT", lastError: null, deliveredMessageId: null });
  });

  it("keeps an accepted send through message backfill and delivery finalization after interruption", async () => {
    const { ctx, channel, session } = await createWorker();
    const sending = deferred<void>(); const sent = deferred<{ id: string }>();
    const finalizing = deferred<void>(); const finalized = deferred<void>();
    channel.send.mockImplementation(async payload => { sending.resolve(); return { ...await sent.promise, payload }; });
    const markDelivered = ctx.ports.outbox.markDelivered;
    ctx.ports.outbox.markDelivered = async (...args) => {
      finalizing.resolve(); await finalized.promise; return markDelivered(...args);
    };
    const failed = vi.spyOn(ctx.ports.outbox, "markFailed");
    const controller = new AbortController(); let settled = false;
    const tick = Effect.runPromiseExit(runOutboxWorkerTick(stubClient(channel), ctx), { signal: controller.signal })
      .then(exit => { settled = true; return exit; });
    try {
      await sending.promise; controller.abort(); await setImmediate();
      expect(settled).toBe(false);
      sent.resolve({ id: "accepted" }); await finalizing.promise; await setImmediate();
      expect(settled).toBe(false);
      expect((await ctx.ports.sessions.findSessionById(session.id))?.askMessageId).toBe("accepted");
      expect(ctx.ports.outbox.listEntries()[0]?.status).toBe("IN_FLIGHT");
    } finally { sent.resolve({ id: "accepted" }); finalized.resolve(); await tick; }
    const exit = await tick;
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isSuccess(exit)) { throw new Error("Expected interruption after finalization."); }
    expect(Cause.hasInterrupts(exit.cause)).toBe(true);
    expect(ctx.ports.outbox.listEntries()[0]).toMatchObject({ status: "DELIVERED", deliveredMessageId: "accepted" });
    expect(failed).not.toHaveBeenCalled();
    expect(channel.send).toHaveBeenCalledOnce();
  });

  it.each(["send", "finalization"] as const)("persists a %s failure before releasing an interrupted delivery", async phase => {
    const { ctx, channel, session } = await createWorker();
    const sending = deferred<void>(); const sent = deferred<{ id: string }>();
    const recording = deferred<void>(); const recorded = deferred<void>();
    channel.send.mockImplementation(async payload => { sending.resolve(); return { ...await sent.promise, payload }; });
    if (phase === "finalization") { ctx.ports.outbox.markDelivered = async () => { throw new Error("write failed"); }; }
    const markFailed = ctx.ports.outbox.markFailed;
    ctx.ports.outbox.markFailed = async (...args) => {
      recording.resolve(); await recorded.promise; return markFailed(...args);
    };
    const controller = new AbortController(); let settled = false;
    const tick = Effect.runPromiseExit(runOutboxWorkerTick(stubClient(channel), ctx), { signal: controller.signal })
      .then(exit => { settled = true; return exit; });
    try {
      await sending.promise; controller.abort();
      if (phase === "send") { sent.reject(new Error("Discord failed")); }
      else { sent.resolve({ id: "accepted" }); }
      await recording.promise; await setImmediate();
      expect(settled).toBe(false);
      expect(ctx.ports.outbox.listEntries()[0]?.status).toBe("IN_FLIGHT");
    } finally { sent.resolve({ id: "accepted" }); recorded.resolve(); await tick; }
    const exit = await tick;
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isSuccess(exit)) { throw new Error("Expected interruption after recording the failure."); }
    expect(Cause.hasInterrupts(exit.cause)).toBe(true);
    expect(ctx.ports.outbox.listEntries()[0]).toMatchObject({ status: "PENDING", lastError: "Outbox delivery failed.",
      nextAttemptAt: new Date("2026-04-24T12:00:01Z") });
    expect((await ctx.ports.sessions.findSessionById(session.id))?.askMessageId).toBe(phase === "send" ? null : "accepted");
    expect(channel.send).toHaveBeenCalledOnce();
  });
});
