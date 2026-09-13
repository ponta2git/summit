import { setImmediate } from "node:timers/promises";
import type { ScheduledTask } from "node-cron";
import { describe, expect, it, vi } from "vitest";
import { createAskScheduler } from "../../src/scheduler/index.ts";
import { CRON_ASK_SCHEDULE, CRON_OUTBOX_RETENTION_SCHEDULE, CRON_SCHEDULER_SUPERVISOR_SCHEDULE } from "../../src/config.ts";
import { createTestAppContext } from "../testing/index.ts";
import { stubClient } from "./outboxWorker.harness.ts";
import { deferred } from "../helpers/deferred.ts";

describe("cron callback lifetime", () => {
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
