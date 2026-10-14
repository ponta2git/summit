import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAttendanceBatch } from "../../src/notifications/delivery/attendanceBatch.ts";
import { createResultDeliveryRuntime } from "../../src/notifications/delivery/resultRuntime.ts";
import { createResultDeliverySource } from "../../src/notifications/delivery/sources/result.ts";
import type { DeliveryRuntime } from "../../src/notifications/delivery/runtime.ts";
import { settledCall } from "../../src/runtime/effect.ts";
import { notificationNow } from "../contracts/resultNotifications.ts";
import { deferred } from "../helpers/deferred.ts";
import { runEffect } from "../helpers/assertions.ts";
import { resultWorkerHarness } from "../scheduler/resultNotifications.harness.ts";

describe("injected delivery ownership", () => {
  let runtime: DeliveryRuntime | undefined;
  const releases: Array<() => void> = [];
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(notificationNow); });
  afterEach(async () => {
    runtime?.stop();
    for (const release of releases.splice(0)) { release(); }
    await runtime?.drain();
    runtime = undefined;
    vi.clearAllTimers(); vi.useRealTimers();
  });

  it("waits for every injected attendance task before returning the first failure", async () => {
    const release = deferred<void>(); const started = deferred<void>();
    const failure = new Error("injected failure"); const events: string[] = [];
    releases.push(() => release.resolve());
    let settled = false;
    const pending = runEffect(Effect.result(runAttendanceBatch({
      claim: budget => {
        expect(budget.slots).toBe(10);
        return Effect.succeed([{ id: "failed" }, { id: "held" }]);
      },
      prepareTask: ({ id }) => ({ id, payloadBytes: 0, run: execution => Effect.suspend(() => {
        expect(execution.isStopping()).toBe(false);
        if (id === "failed") { return Effect.fail(failure); }
        return settledCall(async () => { started.resolve(); await release.promise; events.push("held-complete"); });
      }) })
    }))).then(result => { settled = true; return result; });
    try {
      await started.promise;
      expect(settled).toBe(false);
    } finally { release.resolve(); }
    const result = await pending;
    expect(events).toEqual(["held-complete"]);
    expect(Result.isFailure(result) && result.failure.cause).toBe(failure);
  });

  it("refills result slots using injected tasks and drains them without invoking Discord", async () => {
    const h = resultWorkerHarness();
    const ids = await Promise.all(["a", "b", "c"].map(id => h.enqueue(id, "summary")));
    const held = new Map(ids.map(id => [id, deferred<void>()]));
    for (const item of held.values()) { releases.push(() => item.resolve()); }
    const started: string[] = []; const finished: string[] = [];
    runtime = createResultDeliveryRuntime({ clock: h.clock, logger: h.logger,
      source: createResultDeliverySource(h.port, h.clock),
      prepareTask: entry => ({ id: entry.id, payloadBytes: entry.payloadBytes,
        run: () => settledCall(async () => {
          started.push(entry.id);
          await held.get(entry.id)?.promise;
          finished.push(entry.id);
        }) })
    });
    runtime.wake("receipt"); await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(ids.slice(0, 2));
    held.get(ids[0]!)?.resolve(); await vi.advanceTimersByTimeAsync(1);
    expect(started).toEqual(ids);
    expect(finished).toEqual([ids[0]]);
    runtime.stop();
    let drained = false;
    const draining = runtime.drain().then(() => { drained = true; return undefined; });
    await Promise.resolve(); expect(drained).toBe(false);
    for (const item of held.values()) { item.resolve(); }
    await draining;
    expect(finished).toEqual(ids);
    expect(h.channel.send).not.toHaveBeenCalled();
  });

  it("isolates a throwing attendance factory and still settles its earlier and later siblings", async () => {
    const release = deferred<void>(); const lastStarted = deferred<void>();
    releases.push(() => release.resolve());
    const finished: string[] = [];
    let settled = false;
    const pending = runEffect(Effect.result(runAttendanceBatch({
      claim: () => Effect.succeed(["held", "broken", "last"].map(id => ({ id }))),
      prepareTask: ({ id }) => {
        if (id === "broken") { throw new TypeError("broken injected factory"); }
        return { id, payloadBytes: 0, run: () => settledCall(async () => {
          if (id === "held") { await release.promise; }
          else { lastStarted.resolve(); }
          finished.push(id);
        }) };
      }
    }))).then(result => { settled = true; return result; });
    try {
      await lastStarted.promise;
      expect(settled).toBe(false);
      expect(finished).toEqual(["last"]);
    } finally { release.resolve(); }
    const result = await pending;
    expect(Result.isFailure(result)).toBe(true);
    expect(finished).toEqual(["last", "held"]);
  });

  it("starts no attendance task when stopped during claim, leaving unstarted claims recoverable", async () => {
    const claimEntered = deferred<void>(); const claimCompleted = deferred<void>();
    releases.push(() => claimCompleted.resolve());
    const prepareTask = vi.fn(({ id }: { id: string }) => ({ id, payloadBytes: 0, run: () => Effect.void }));
    let stopping = false;
    const pending = runEffect(runAttendanceBatch({
      claim: () => settledCall(async () => { claimEntered.resolve(); await claimCompleted.promise; return [{ id: "claimed" }]; }),
      prepareTask
    }, () => stopping));
    await claimEntered.promise;
    stopping = true;
    claimCompleted.resolve();
    expect(await pending).toEqual({ claimed: 1 });
    expect(prepareTask).not.toHaveBeenCalled();
  });

  it("isolates an invalid injected reservation without losing its sibling or starting the invalid task", async () => {
    const h = resultWorkerHarness();
    const badId = await h.enqueue("a-invalid", "summary");
    const goodId = await h.enqueue("b-valid", "summary");
    const started: string[] = [];
    runtime = createResultDeliveryRuntime({ clock: h.clock, logger: h.logger,
      source: createResultDeliverySource(h.port, h.clock),
      prepareTask: entry => ({ id: entry.id, payloadBytes: entry.id === badId ? 0 : entry.payloadBytes,
        run: () => Effect.sync(() => { started.push(entry.id); }) })
    });
    runtime.wake("receipt"); await vi.advanceTimersByTimeAsync(0);
    await runtime.drain();
    expect(started).toEqual([goodId]);
    expect(h.logger.error).toHaveBeenCalledExactlyOnceWith({ event: "result_notification.dispatch_failed", notificationId: badId });
    expect(h.port.calls.some(call => call.name === "fail")).toBe(false);
  });
});
