import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createResultDeliveryRuntime } from "../../src/notifications/delivery/resultRuntime.ts";
import { createResultDeliverySource, type ResultDeliverySource } from "../../src/notifications/delivery/sources/result.ts";
import type { DeliveryRuntime } from "../../src/notifications/delivery/runtime.ts";
import { fromDatabaseCall } from "../../src/errors/effect.ts";
import { DatabaseError } from "../../src/errors/index.ts";
import { RESULT_NOTIFICATION_CLAIM_BUDGET_BYTES, RESULT_NOTIFICATION_RECOVERY_BACKOFF_MS,
  SCHEDULER_MIN_TIMER_DELAY_MS } from "../../src/config.ts";
import { notificationNow } from "../contracts/resultNotifications.ts";
import { deferred } from "../helpers/deferred.ts";
import { resultWorkerHarness } from "../scheduler/resultNotifications.harness.ts";

describe("result pump progress and observation", () => {
  let runtime: DeliveryRuntime | undefined;
  const releases: Array<() => void> = [];
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(notificationNow); });
  afterEach(async () => {
    runtime?.stop(); releases.splice(0).forEach(release => release());
    await runtime?.drain(); runtime = undefined; vi.clearAllTimers(); vi.useRealTimers();
  });
  const source = (): ResultDeliverySource => ({ claim: () => Effect.succeed([]), nextDispatchAt: () => Effect.succeed(null),
    wake: () => undefined, claimed: () => () => false });

  it("starts older fitting work despite a preferred large row and a never-settling retained SDK owner", async () => {
    const h = resultWorkerHarness(); await h.enqueueOcr(); const previous = await h.claim(); await h.deliver(previous);
    const selected = createResultDeliverySource(h.port, h.clock); selected.claimed(previous);
    const held = deferred<void>(); releases.push(() => held.resolve());
    void h.io.run({ id: "retained-sdk", payloadBytes: 200 * 1024 }, "send", 0, () => held.promise);
    await vi.advanceTimersByTimeAsync(1);
    const older = await h.enqueueOcr("22222222-2222-4222-8222-222222222222");
    await vi.advanceTimersByTimeAsync(1);
    const large = await h.enqueue("younger-preferred", "x".repeat(400 * 1024));
    const started: string[] = [];
    runtime = createResultDeliveryRuntime({ ...h, source: selected,
      prepareTask: entry => ({ id: entry.id, payloadBytes: entry.payloadBytes,
        run: () => Effect.sync(() => { started.push(entry.id); }) }) });
    runtime.wake("receipt"); await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(started).toEqual([older]);
    expect(await h.port.inspect(large)).toMatchObject({ status: "PENDING", attemptCount: 0 });
    expect(h.io.snapshot().pending).toBe(1);
  });

  it("schedules an item that becomes due during dispatch lookup while an SDK owner remains retained", async () => {
    const h = resultWorkerHarness(); await h.enqueue("due", "short"); const entry = await h.claim();
    const held = deferred<void>(); releases.push(() => held.resolve());
    void h.io.run({ id: "retained", payloadBytes: 1 }, "send", 0, () => held.promise);
    const dueAt = new Date(notificationNow.getTime() + 10); const started: string[] = [];
    const claim = vi.fn<ResultDeliverySource["claim"]>().mockReturnValueOnce(Effect.succeed([]))
      .mockReturnValueOnce(Effect.succeed([entry])).mockReturnValue(Effect.succeed([]));
    const next = vi.fn<ResultDeliverySource["nextDispatchAt"]>().mockImplementationOnce(() => Effect.sync(() => {
      vi.setSystemTime(new Date(notificationNow.getTime() + 20)); return dueAt;
    })).mockReturnValue(Effect.succeed(null));
    runtime = createResultDeliveryRuntime({ ...h, source: { ...source(), claim, nextDispatchAt: next },
      prepareTask: value => ({ id: value.id, payloadBytes: value.payloadBytes, run: () => Effect.sync(() => { started.push(value.id); }) }) });
    runtime.wake("receipt"); await vi.advanceTimersByTimeAsync(0);
    expect(claim).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(SCHEDULER_MIN_TIMER_DELAY_MS - 1); expect(started).toEqual([]);
    await vi.advanceTimersByTimeAsync(1); expect(started).toEqual([entry.id]);
  });

  it("makes at most one extra claim for an over-budget item that crossed its due time", async () => {
    const h = resultWorkerHarness(); const held = deferred<void>(); releases.push(() => held.resolve());
    void h.io.run({ id: "retained", payloadBytes: RESULT_NOTIFICATION_CLAIM_BUDGET_BYTES - 1 }, "send", 0, () => held.promise);
    const dueAt = new Date(notificationNow.getTime() + 10);
    const claim = vi.fn<ResultDeliverySource["claim"]>().mockReturnValue(Effect.succeed([]));
    const next = vi.fn<ResultDeliverySource["nextDispatchAt"]>().mockImplementationOnce(() => Effect.sync(() => {
      vi.setSystemTime(new Date(notificationNow.getTime() + 20)); return dueAt;
    })).mockReturnValue(Effect.succeed(dueAt));
    runtime = createResultDeliveryRuntime({ ...h, source: { ...source(), claim, nextDispatchAt: next },
      prepareTask: () => { throw new Error("No task fits the remaining byte budget"); } });
    runtime.wake("receipt"); await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(claim).toHaveBeenCalledTimes(2); expect(h.port.calls.some(call => call.name === "fail")).toBe(false);
  });

  it("monitors one unsettled dispatch read for twenty minutes and resumes queued wakes after settlement", async () => {
    const h = resultWorkerHarness(); const read = deferred<Date | null>(); releases.push(() => read.resolve(null));
    const claim = vi.fn<ResultDeliverySource["claim"]>().mockReturnValue(Effect.succeed([]));
    const next = vi.fn<ResultDeliverySource["nextDispatchAt"]>().mockImplementationOnce(() =>
      fromDatabaseCall(() => read.promise, "Dispatch read failed")).mockReturnValue(Effect.succeed(null));
    h.logger.warn.mockImplementation(() => { throw new Error("Logging is unavailable"); });
    runtime = createResultDeliveryRuntime({ ...h, source: { ...source(), claim, nextDispatchAt: next },
      prepareTask: () => { throw new Error("No claimed rows"); } });
    runtime.wake("startup"); await vi.advanceTimersByTimeAsync(0); runtime.wake("receipt");
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(claim).toHaveBeenCalledOnce(); expect(next).toHaveBeenCalledOnce();
    expect(h.logger.warn).toHaveBeenCalledTimes(19);
    expect(h.logger.warn.mock.calls[0]?.[0]).toEqual({ event: "result_notification.database_pending", phase: "next_dispatch", elapsedMs: 90_000 });
    read.resolve(null); await vi.advanceTimersByTimeAsync(1); expect(claim).toHaveBeenCalledTimes(2);
  });

  it("keeps recovery timers and rejected-pump cleanup safe when every logger method throws", async () => {
    const h = resultWorkerHarness();
    for (const log of Object.values(h.logger)) { log.mockImplementation(() => { throw new Error("Logging is unavailable"); }); }
    const claim = vi.fn<ResultDeliverySource["claim"]>()
      .mockReturnValueOnce(Effect.fail(new DatabaseError("Temporary outage")))
      .mockReturnValueOnce(Effect.die(new Error("Unexpected defect"))).mockReturnValue(Effect.succeed([]));
    runtime = createResultDeliveryRuntime({ ...h, source: { ...source(), claim },
      prepareTask: () => { throw new Error("No claimed rows"); } });
    expect(() => runtime?.wake("startup")).not.toThrow(); await vi.advanceTimersByTimeAsync(0);
    expect(claim).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(RESULT_NOTIFICATION_RECOVERY_BACKOFF_MS[0]);
    expect(claim).toHaveBeenCalledTimes(2); await runtime.drain();
    expect(h.logger.error).toHaveBeenCalledWith({ event: "result_notification.dispatch_failed" });
  });

  it("retains a wake received during the last failed pump without starting indefinite retry polling", async () => {
    const h = resultWorkerHarness(); const failed = deferred<void>(); releases.push(() => failed.resolve());
    let attempts = 0;
    const claim = vi.fn<ResultDeliverySource["claim"]>(() => {
      attempts += 1;
      if (attempts <= RESULT_NOTIFICATION_RECOVERY_BACKOFF_MS.length) { return Effect.fail(new DatabaseError("Offline")); }
      if (attempts === RESULT_NOTIFICATION_RECOVERY_BACKOFF_MS.length + 1) {
        return fromDatabaseCall(async () => { await failed.promise; throw new Error("Delayed failure"); }, "Offline");
      }
      return Effect.succeed([]);
    });
    runtime = createResultDeliveryRuntime({ ...h, source: { ...source(), claim },
      prepareTask: () => { throw new Error("No claimed rows"); } });
    runtime.wake("startup"); await vi.advanceTimersByTimeAsync(0);
    for (const delay of RESULT_NOTIFICATION_RECOVERY_BACKOFF_MS) { await vi.advanceTimersByTimeAsync(delay); }
    runtime.wake("receipt"); failed.resolve(); await vi.advanceTimersByTimeAsync(1);
    expect(claim).toHaveBeenCalledTimes(RESULT_NOTIFICATION_RECOVERY_BACKOFF_MS.length + 2);
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(claim).toHaveBeenCalledTimes(RESULT_NOTIFICATION_RECOVERY_BACKOFF_MS.length + 2);
  });
});
