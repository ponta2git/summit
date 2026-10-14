import * as Effect from "effect/Effect";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSchedulerController } from "../../src/scheduler/controller.ts";
import type { SchedulerEffect } from "../../src/scheduler/scheduler.types.ts";
import { OUTBOX_WORKER_BATCH_LIMIT, SCHEDULER_MIN_TIMER_DELAY_MS, SCHEDULER_WAKE_DEBOUNCE_MS } from "../../src/config.ts";
import { DatabaseError } from "../../src/errors/index.ts";
import { createTestAppContext } from "../testing/index.ts";
import { buildSessionRow } from "../testing/sessionScenario.ts";
import { deferred } from "../helpers/deferred.ts";
import { stubChannel, stubClient } from "./outboxWorker.harness.ts";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const okTask = (): SchedulerEffect<void> => Effect.succeed(undefined);
const options = (context: ReturnType<typeof createTestAppContext>) => ({ client: stubClient(undefined), context, logger,
  runDeadlineTick: vi.fn(okTask), runPostponeDeadlineTick: vi.fn(okTask), runReminderTick: vi.fn(okTask) });

describe("scheduler work ownership", () => {
  let stopWork: (() => void) | undefined;
  let releaseWork: (() => void) | undefined;
  let drainWork: (() => Promise<void>) | undefined;
  afterEach(async () => {
    try { stopWork?.(); releaseWork?.(); await drainWork?.(); }
    finally {
      stopWork = undefined; releaseWork = undefined; drainWork = undefined;
      vi.useRealTimers();
    }
  });

  it("does not start due commands after stop while hints were being read", async () => {
    const ctx = createTestAppContext(); const hints = deferred<Awaited<ReturnType<typeof ctx.ports.sessions.getSchedulerSessionHints>>>();
    ctx.ports.sessions.getSchedulerSessionHints = () => hints.promise;
    const deps = options(ctx); const controller = createSchedulerController(deps);
    stopWork = () => controller.stop(); drainWork = () => controller.drain();
    releaseWork = () => hints.resolve({ nextAskingDeadlineAt: null, nextPostponeDeadlineAt: null, nextReminderAt: null });
    const recompute = controller.recompute("test"); controller.stop();
    hints.resolve({ nextAskingDeadlineAt: ctx.clock.now(), nextPostponeDeadlineAt: null, nextReminderAt: null });
    await recompute;
    expect(deps.runDeadlineTick).not.toHaveBeenCalled();
  });

  it("keeps a pending hint read in drain when its parallel query has already failed", async () => {
    const ctx = createTestAppContext();
    const started = deferred<void>(); const next = deferred<Date | null>();
    ctx.ports.sessions.getSchedulerSessionHints = async () => { throw new Error("query unavailable"); };
    ctx.ports.outbox.getNextDispatchAt = () => { started.resolve(); return next.promise; };
    const deps = options(ctx); const controller = createSchedulerController(deps);
    stopWork = () => controller.stop(); drainWork = () => controller.drain(); releaseWork = () => next.resolve(null);
    const recompute = controller.recompute("failing_query"); await started.promise;
    controller.stop(); let drained = false;
    const drain = controller.drain().then(() => { drained = true; return undefined; });
    await setImmediate();
    expect(drained).toBe(false);
    next.resolve(null); await recompute; await drain;
    expect(drained).toBe(true);
    expect(deps.runDeadlineTick).not.toHaveBeenCalled();
  });

  it("joins a timer tick during recompute and drains it before shutdown completes", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-04-24T12:00:00Z"); vi.setSystemTime(now);
    const ctx = createTestAppContext({ now: () => new Date() }); const deadline = new Date(now.getTime() + 1_000);
    const hints = { nextAskingDeadlineAt: deadline, nextPostponeDeadlineAt: null, nextReminderAt: null };
    ctx.ports.sessions.getSchedulerSessionHints = async () => hints;
    const work = deferred<void>(); const deps = options(ctx);
    deps.runDeadlineTick.mockImplementation(() => Effect.tryPromise({ try: () => work.promise, catch: cause => new DatabaseError("tick", { cause }) }));
    const controller = createSchedulerController(deps);
    stopWork = () => controller.stop(); drainWork = () => controller.drain(); releaseWork = () => work.resolve();
    await controller.recompute("schedule");
    await vi.advanceTimersByTimeAsync(1_000);
    hints.nextAskingDeadlineAt = now;
    const recompute = controller.recompute("concurrent_wake"); await setImmediate();
    expect(deps.runDeadlineTick).toHaveBeenCalledOnce();
    controller.stop(); let drained = false;
    const drain = controller.drain().then(() => { drained = true; return undefined; }); await setImmediate();
    expect(drained).toBe(false);
    work.resolve(); await recompute; await drain;
    expect(drained).toBe(true);
    expect(deps.runDeadlineTick).toHaveBeenCalledOnce();
  });

  it("keeps a single outbox batch active across wakes and drains all claimed sends", async () => {
    vi.useFakeTimers();
    const sessions = Array.from({ length: OUTBOX_WORKER_BATCH_LIMIT + 1 }, (_, index) => buildSessionRow({
      id: `week-${index}`, status: "SKIPPED", cancelReason: "manual_skip", revision: 1,
      candidateDateIso: new Date(Date.UTC(2026, 0, 2 + index * 7)).toISOString().slice(0, 10)
    }));
    const ctx = createTestAppContext({ seed: { sessions } });
    for (const session of sessions) {
      await ctx.ports.outbox.enqueue({ kind: "send_message", sessionId: session.id, dedupeKey: `cancel-week-notice-${session.weekKey}`,
        aggregateRevision: 1, ordinal: 0, payload: { kind: "send_message", channelId: session.channelId,
          renderer: "cancel_week_notice", extra: { invokerUserId: "333333333333333333", suppressMentions: true } } });
    }
    const sent = deferred<{ id: string }>();
    const channel = { type: 0, isSendable: () => true, send: vi.fn(() => sent.promise) };
    const controller = createSchedulerController({ ...options(ctx), client: stubClient(channel) });
    stopWork = () => controller.stop(); drainWork = () => controller.drain(); releaseWork = () => sent.resolve({ id: "accepted" });
    await controller.recompute("first"); await vi.advanceTimersByTimeAsync(SCHEDULER_MIN_TIMER_DELAY_MS);
    expect(channel.send).toHaveBeenCalledTimes(OUTBOX_WORKER_BATCH_LIMIT);
    await controller.recompute("new_intent"); await vi.advanceTimersByTimeAsync(SCHEDULER_MIN_TIMER_DELAY_MS);
    expect(channel.send).toHaveBeenCalledTimes(OUTBOX_WORKER_BATCH_LIMIT);
    controller.stop(); let drained = false;
    const drain = controller.drain().then(() => { drained = true; return undefined; }); await setImmediate();
    expect(drained).toBe(false);
    sent.resolve({ id: "accepted" }); await drain;
    expect(ctx.ports.outbox.listEntries().filter(entry => entry.status === "DELIVERED")).toHaveLength(OUTBOX_WORKER_BATCH_LIMIT);
    expect(ctx.ports.outbox.listEntries().filter(entry => entry.status === "PENDING")).toHaveLength(1);
  });

  it("re-reads a wake that races the completed batch's stale idle query", async () => {
    vi.useFakeTimers();
    const sessions = [buildSessionRow({ id: "first", status: "SKIPPED", cancelReason: "manual_skip" }),
      buildSessionRow({ id: "second", status: "SKIPPED", cancelReason: "manual_skip", candidateDateIso: "2026-05-01" })];
    const ctx = createTestAppContext({ seed: { sessions }, now: () => new Date() });
    const enqueue = async (index: number) => {
      const session = sessions[index];
      if (!session) { throw new Error("Missing fixture session."); }
      await ctx.ports.outbox.enqueue({ kind: "send_message", sessionId: session.id, dedupeKey: `notice-${session.id}`,
        aggregateRevision: 0, ordinal: 0, payload: { kind: "send_message", channelId: session.channelId,
          renderer: "settle_notice", extra: { reason: "absent" } } });
    };
    const readingIdle = deferred<void>(); const idle = deferred<Date | null>();
    const readNext = ctx.ports.outbox.getNextDispatchAt;
    let calls = 0;
    ctx.ports.outbox.getNextDispatchAt = async () => {
      if (++calls === 2) { readingIdle.resolve(); return idle.promise; }
      return readNext();
    };
    const { channel } = stubChannel();
    const controller = createSchedulerController({ ...options(ctx), client: stubClient(channel) });
    stopWork = () => controller.stop(); drainWork = () => controller.drain(); releaseWork = () => idle.resolve(null);
    await enqueue(0);
    await controller.recompute("first");
    await vi.advanceTimersByTimeAsync(SCHEDULER_MIN_TIMER_DELAY_MS);
    await readingIdle.promise;
    expect(channel.send).toHaveBeenCalledOnce();
    await enqueue(1);
    await controller.recompute("second_intent");
    idle.resolve(null);
    await controller.drain();
    await vi.advanceTimersByTimeAsync(SCHEDULER_WAKE_DEBOUNCE_MS + SCHEDULER_MIN_TIMER_DELAY_MS);
    expect(channel.send).toHaveBeenCalledTimes(2);
    expect(ctx.ports.outbox.listEntries().map(entry => entry.status)).toEqual(["DELIVERED", "DELIVERED"]);
  });
});
