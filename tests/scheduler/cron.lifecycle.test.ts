import { setImmediate } from "node:timers/promises";
import type { ScheduledTask } from "node-cron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAskScheduler } from "../../src/scheduler/index.ts";
import { CRON_ASK_SCHEDULE, CRON_OUTBOX_RETENTION_SCHEDULE, CRON_SCHEDULER_SUPERVISOR_SCHEDULE,
  SCHEDULER_RECOVERY_BACKOFF_MS } from "../../src/config.ts";
import { createTestAppContext } from "../testing/index.ts";
import { stubClient } from "./outboxWorker.harness.ts";
import { deferred } from "../helpers/deferred.ts";
import { buildSessionRow } from "../testing/sessionScenario.ts";

describe("cron callback lifetime", () => {
  afterEach(() => { vi.useRealTimers(); });

  it.each(["getMetrics", "releaseExpiredClaims"] as const)("still queues due work when %s fails in the supervisor", async failedOperation => {
    vi.useFakeTimers();
    const now = new Date("2026-04-24T12:45:00Z");
    const session = buildSessionRow({ id: "supervisor-isolation", status: "DECIDED",
      reminderAt: now, decidedStartAt: new Date("2026-04-24T13:00:00Z") });
    const context = createTestAppContext({ seed: { sessions: [session] }, now });
    context.ports.outbox[failedOperation] = async () => { throw new Error("unavailable"); };
    const callbacks = new Map<string, () => void | Promise<void>>();
    const wakeResults = vi.fn();
    const scheduler = createAskScheduler({ client: stubClient(undefined), context, wakeResultNotifications: wakeResults,
      cronAdapter: { schedule: (expression, callback) => { callbacks.set(expression, callback); return { stop: vi.fn() }; } } });
    try {
      await callbacks.get(CRON_SCHEDULER_SUPERVISOR_SCHEDULE)?.();
      expect(wakeResults).toHaveBeenCalledExactlyOnceWith("supervisor");
      expect(context.ports.outbox.listEntries().map(entry => entry.dedupeKey)).toStrictEqual(["reminder-supervisor-isolation"]);
    } finally { scheduler.stop(); await scheduler.drain(); }
  });

  it("rolls back earlier cron registrations when a later registration throws", async () => {
    const failure = new Error("registration failed");
    const stops = [vi.fn(), vi.fn(() => { throw new Error("cleanup failed"); })];
    const callbacks: Array<() => void | Promise<void>> = [];
    const sendAsk = vi.fn(async () => ({ status: "queued" as const, weekKey: "2026-W17" }));
    expect(() => createAskScheduler({ client: stubClient(undefined), context: createTestAppContext(), sendAsk,
      cronAdapter: { schedule: (_expression, callback) => {
        const stop = stops[callbacks.length];
        if (!stop) { throw failure; }
        callbacks.push(callback); return { stop };
      } }
    })).toThrow(failure);
    await Promise.all(callbacks.map(callback => callback()));
    for (const stop of stops) { expect(stop).toHaveBeenCalledOnce(); }
    expect(sendAsk).not.toHaveBeenCalled();
  });

  it("stops each registered producer once across repeated shutdown requests", async () => {
    const stop = vi.fn();
    const scheduler = createAskScheduler({ client: stubClient(undefined), context: createTestAppContext(),
      cronAdapter: { schedule: () => ({ stop }) } });
    scheduler.stop(); scheduler.stop(); await scheduler.drain();
    expect(stop).toHaveBeenCalledTimes(3);
  });

  it("retries an item failure reported by a reminder batch instead of treating the report as success", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-04-24T12:45:00Z");
    const session = buildSessionRow({ id: "reminder-retry", status: "DECIDED", reminderAt: now,
      decidedStartAt: new Date("2026-04-24T13:00:00Z") });
    const context = createTestAppContext({ seed: { sessions: [session] }, now });
    vi.spyOn(context.ports.outbox, "enqueue").mockRejectedValueOnce(new Error("transient enqueue failure"));
    const scheduler = createAskScheduler({ client: stubClient(undefined), context,
      cronAdapter: { schedule: () => ({ stop: vi.fn() }) } });
    try {
      await scheduler.controller.recompute("deadline");
      expect(context.ports.outbox.listEntries()).toEqual([]);
      await vi.advanceTimersByTimeAsync(SCHEDULER_RECOVERY_BACKOFF_MS[0]);
      expect(context.ports.outbox.listEntries().map(entry => entry.dedupeKey)).toStrictEqual(["reminder-reminder-retry"]);
    } finally { scheduler.stop(); await scheduler.drain(); }
  });

  it.each([CRON_ASK_SCHEDULE, CRON_OUTBOX_RETENTION_SCHEDULE, CRON_SCHEDULER_SUPERVISOR_SCHEDULE])(
    "keeps %s pending until its work completes and includes it in shutdown drain", async expression => {
      const context = createTestAppContext(); const pending = deferred<void>(); const callbacks = new Map<string, () => void | Promise<void>>();
      const sendAsk = vi.fn(async () => { await pending.promise; return { status: "queued" as const, weekKey: "2026-W17" }; });
      const prune = context.ports.outbox.prune;
      context.ports.outbox.prune = async (...args) => { await pending.promise; return prune(...args); };
      const getMetrics = context.ports.outbox.getMetrics;
      context.ports.outbox.getMetrics = async (...args) => { await pending.promise; return getMetrics(...args); };
      const schedule = (expr: string, callback: () => void | Promise<void>): Pick<ScheduledTask, "stop"> => {
        callbacks.set(expr, callback); return { stop: vi.fn() };
      };
      const scheduler = createAskScheduler({ client: stubClient(undefined), context, sendAsk, cronAdapter: { schedule } });
      const callback = callbacks.get(expression); if (!callback) { throw new Error("Cron callback missing"); }
      const callbackResult = callback();
      expect(callbackResult).toBeInstanceOf(Promise);
      scheduler.stop(); let drained = false;
      const drain = scheduler.drain().then(() => { drained = true; return undefined; }); await setImmediate();
      expect(drained).toBe(false);
      pending.resolve(); await callbackResult; await drain;
      expect(drained).toBe(true);
      const calls = context.ports.outbox.calls.length;
      await callback(); expect(context.ports.outbox.calls).toHaveLength(calls);
    }
  );
});
