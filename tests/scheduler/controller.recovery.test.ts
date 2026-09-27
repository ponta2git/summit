import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSchedulerController, type SchedulerController } from "../../src/scheduler/controller.ts";
import { SCHEDULER_MIN_TIMER_DELAY_MS, SCHEDULER_RECOVERY_BACKOFF_MS, SCHEDULER_WAKE_DEBOUNCE_MS } from "../../src/config.ts";
import { DatabaseError } from "../../src/errors/index.ts";
import { createTestAppContext } from "../testing/index.ts";
import { buildSessionRow } from "../testing/sessionScenario.ts";
import { stubChannel, stubClient } from "./outboxWorker.harness.ts";

const ok = () => Effect.void;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const createController = (context: ReturnType<typeof createTestAppContext>) => createSchedulerController({
  client: stubClient(undefined), context, logger, runDeadlineTick: ok, runPostponeDeadlineTick: ok, runReminderTick: ok
});

describe("scheduler transient-failure recovery", () => {
  let controller: SchedulerController | undefined;
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-04-24T12:00:00Z")); });
  afterEach(async () => { controller?.stop(); await controller?.drain(); controller = undefined; vi.clearAllTimers(); vi.useRealTimers(); });

  it("retries a failed hint read without waiting for a supervisor and resets its finite budget after success", async () => {
    const context = createTestAppContext();
    const hints = vi.spyOn(context.ports.sessions, "getSchedulerSessionHints");
    hints.mockRejectedValue(new Error("database unavailable"));
    controller = createController(context);
    await controller.recompute("startup");
    for (const delay of SCHEDULER_RECOVERY_BACKOFF_MS) { await vi.advanceTimersByTimeAsync(delay); }
    expect(hints).toHaveBeenCalledTimes(SCHEDULER_RECOVERY_BACKOFF_MS.length + 1);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(hints).toHaveBeenCalledTimes(SCHEDULER_RECOVERY_BACKOFF_MS.length + 1);
    hints.mockResolvedValue({ nextAskingDeadlineAt: null, nextPostponeDeadlineAt: null, nextReminderAt: null });
    controller.wake("supervisor"); await vi.advanceTimersByTimeAsync(SCHEDULER_WAKE_DEBOUNCE_MS);
    hints.mockClear().mockRejectedValue(new Error("second outage"));
    controller.wake("new_intent"); await vi.advanceTimersByTimeAsync(SCHEDULER_WAKE_DEBOUNCE_MS);
    for (const delay of SCHEDULER_RECOVERY_BACKOFF_MS) { await vi.advanceTimersByTimeAsync(delay); }
    expect(hints).toHaveBeenCalledTimes(SCHEDULER_RECOVERY_BACKOFF_MS.length + 1);
  });

  it("bounds failing due ticks and recovers on a later explicit wake", async () => {
    const context = createTestAppContext();
    const hints = { nextAskingDeadlineAt: context.clock.now() as Date | null, nextPostponeDeadlineAt: null, nextReminderAt: null };
    context.ports.sessions.getSchedulerSessionHints = async () => hints;
    const deadline = vi.fn<() => Effect.Effect<void, DatabaseError>>(() => Effect.fail(new DatabaseError("deadline unavailable")));
    controller = createSchedulerController({ client: stubClient(undefined), context, logger,
      runDeadlineTick: deadline, runPostponeDeadlineTick: ok, runReminderTick: ok });
    await controller.recompute("due");
    for (const delay of SCHEDULER_RECOVERY_BACKOFF_MS) { await vi.advanceTimersByTimeAsync(delay); }
    expect(deadline).toHaveBeenCalledTimes(SCHEDULER_RECOVERY_BACKOFF_MS.length + 1);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(deadline).toHaveBeenCalledTimes(SCHEDULER_RECOVERY_BACKOFF_MS.length + 1);
    deadline.mockImplementation(() => Effect.sync(() => { hints.nextAskingDeadlineAt = null; }));
    controller.wake("supervisor"); await vi.advanceTimersByTimeAsync(SCHEDULER_WAKE_DEBOUNCE_MS);
    expect(hints.nextAskingDeadlineAt).toBeNull();
  });

  it.each(["claim", "next_dispatch"] as const)("resumes outbox delivery after a transient %s failure", async phase => {
    const sessions = [buildSessionRow({ id: "first" }), buildSessionRow({ id: "next", weekKey: "2026-W18" })];
    const context = createTestAppContext({ seed: { sessions }, now: () => new Date() });
    const enqueue = async (session: typeof sessions[number]) => context.ports.outbox.enqueue({ kind: "send_message",
      sessionId: session.id, dedupeKey: `notice-${session.id}`, aggregateRevision: 0, ordinal: 0,
      payload: { kind: "send_message", channelId: session.channelId, renderer: "settle_notice", extra: { reason: "absent" } } });
    const first = sessions[0]; const next = sessions[1];
    if (!first || !next) { throw new Error("fixture missing"); }
    await enqueue(first);
    if (phase === "claim") { vi.spyOn(context.ports.outbox, "claimNextBatch").mockRejectedValueOnce(new Error("claim unavailable")); }
    else {
      const getNext = context.ports.outbox.getNextDispatchAt;
      let calls = 0;
      context.ports.outbox.getNextDispatchAt = async now => {
        calls += 1; if (calls === 2) { throw new Error("dispatch query unavailable"); } return getNext(now);
      };
    }
    const { channel } = stubChannel();
    controller = createSchedulerController({ client: stubClient(channel), context, logger,
      runDeadlineTick: ok, runPostponeDeadlineTick: ok, runReminderTick: ok });
    await controller.recompute("work_available");
    await vi.advanceTimersByTimeAsync(SCHEDULER_MIN_TIMER_DELAY_MS);
    const sent = phase === "claim" ? 0 : 1;
    expect(channel.send).toHaveBeenCalledTimes(sent);
    if (phase === "next_dispatch") { await enqueue(next); }
    await vi.advanceTimersByTimeAsync(SCHEDULER_RECOVERY_BACKOFF_MS[0] - 1);
    expect(channel.send).toHaveBeenCalledTimes(sent);
    await vi.advanceTimersByTimeAsync(1);
    expect(context.ports.outbox.listEntries().map(entry => entry.status)).toStrictEqual(
      phase === "claim" ? ["DELIVERED"] : ["DELIVERED", "DELIVERED"]);
  });
});
