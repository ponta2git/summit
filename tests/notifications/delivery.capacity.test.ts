import { setImmediate } from "node:timers/promises";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { describe, expect, it, vi } from "vitest";
import { createDeliveryCapacity } from "../../src/notifications/delivery/capacity.ts";
import { settledCall } from "../../src/runtime/effect.ts";
import { runEffect } from "../helpers/assertions.ts";
import { deferred } from "../helpers/deferred.ts";

describe("delivery capacity ownership", () => {
  it("reserves count and bytes together and supplies the reservation identity to arbitrary work", async () => {
    const capacity = createDeliveryCapacity({ laneId: "results", slots: 2, payloadBytes: 100 });
    const release = deferred<void>();
    const identities: unknown[] = [];
    try {
      await runEffect(capacity.start("first-source", 40, execution => {
        identities.push({ id: execution.deliveryId, lane: execution.laneId, stopping: execution.isStopping() });
        return settledCall(() => release.promise);
      }));
      await runEffect(capacity.start("another-source", 60, () => settledCall(() => release.promise)));
      expect(capacity.snapshot()).toEqual({ slots: 0, payloadBytes: 0, activeIds: ["first-source", "another-source"], allowOversized: false });
      expect(identities).toEqual([{ id: "first-source", lane: "results", stopping: false }]);
      const refused = await runEffect(Effect.exit(capacity.start("overflow", 0, () => Effect.void)));
      expect(Exit.isFailure(refused)).toBe(true);
      expect(capacity.snapshot().activeIds).toEqual(["first-source", "another-source"]);
    } finally { release.resolve(); capacity.stop(); await runEffect(capacity.drain()); await runEffect(capacity.close()); }
    expect(capacity.snapshot()).toEqual({ slots: 2, payloadBytes: 100, activeIds: [], allowOversized: true });
  });

  it("admits an oversized reservation only while idle and excludes other work until it settles", async () => {
    const capacity = createDeliveryCapacity({ laneId: "results", slots: 2, payloadBytes: 100 });
    const release = deferred<void>();
    try {
      await runEffect(capacity.start("historical", 150, () => settledCall(() => release.promise)));
      expect(capacity.snapshot()).toEqual({ slots: 1, payloadBytes: -50, activeIds: ["historical"], allowOversized: false });
      const refused = await runEffect(Effect.exit(capacity.start("normal", 1, () => Effect.void)));
      expect(Exit.isFailure(refused)).toBe(true);
      expect(capacity.snapshot().activeIds).toEqual(["historical"]);
    } finally { release.resolve(); capacity.stop(); await runEffect(capacity.drain()); await runEffect(capacity.close()); }
  });

  it("takes the drain snapshot when executed, including work started after the drain Effect was constructed", async () => {
    const capacity = createDeliveryCapacity({ laneId: "attendance", slots: 1 });
    const drain = capacity.drain(); const release = deferred<void>();
    await runEffect(capacity.start("late-start", 0, () => settledCall(() => release.promise)));
    capacity.stop();
    let drained = false;
    const pending = runEffect(drain).then(() => { drained = true; return undefined; });
    try { await setImmediate(); expect(drained).toBe(false); }
    finally { release.resolve(); await pending; await runEffect(capacity.close()); }
    expect(drained).toBe(true);
  });

  it("releases a reservation and reports the original defect when synchronous preparation throws", async () => {
    const onSettled = vi.fn();
    const capacity = createDeliveryCapacity({ laneId: "results", slots: 1, payloadBytes: 100, onSettled });
    const defect = new Error("preparation invariant");
    try {
      const fiber = await runEffect(capacity.start("invalid", 80, () => { throw defect; }));
      const exit = await runEffect(Fiber.await(fiber));
      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) { throw new Error("Expected preparation defect"); }
      expect(Cause.hasDies(exit.cause)).toBe(true);
      expect(Cause.squash(exit.cause)).toBe(defect);
      expect(capacity.snapshot()).toEqual({ slots: 1, payloadBytes: 100, activeIds: [], allowOversized: true });
      expect(onSettled).toHaveBeenCalledExactlyOnceWith("invalid", exit);
    } finally { await runEffect(capacity.close()); }
  });

  it("keeps capacity reserved until an already-started cleanup actually settles", async () => {
    const capacity = createDeliveryCapacity({ laneId: "results", slots: 1, payloadBytes: 100 });
    const started = deferred<void>(); const cleanup = deferred<void>();
    const fiber = await runEffect(capacity.start("cleanup", 80, () => Effect.void.pipe(Effect.ensuring(
      settledCall(() => { started.resolve(); return cleanup.promise; }).pipe(Effect.orDie)
    ))));
    try {
      await started.promise;
      expect(capacity.snapshot()).toEqual({ slots: 0, payloadBytes: 20, activeIds: ["cleanup"], allowOversized: false });
    } finally { cleanup.resolve(); await runEffect(Fiber.await(fiber)); await runEffect(capacity.close()); }
    expect(capacity.snapshot().activeIds).toEqual([]);
  });

  it("prevents starts after close without leaking a reservation into a closed scope", async () => {
    const capacity = createDeliveryCapacity({ laneId: "attendance", slots: 1 });
    await runEffect(capacity.close());
    expect(capacity.isStopping()).toBe(true);
    const work = vi.fn(() => Effect.void);
    const exit = await runEffect(Effect.exit(capacity.start("after-close", 0, work)));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(work).not.toHaveBeenCalled();
    expect(capacity.snapshot().activeIds).toEqual([]);
  });

  it("reserves atomically when competing starts would individually fit the same byte budget", async () => {
    const capacity = createDeliveryCapacity({ laneId: "results", slots: 8, payloadBytes: 100 });
    const release = deferred<void>();
    try {
      const exits = await runEffect(Effect.all(Array.from({ length: 8 }, (_, index) => Effect.exit(
        capacity.start(`competing-${index}`, 60, () => settledCall(() => release.promise))
      )), { concurrency: "unbounded" }));
      expect(exits.filter(Exit.isSuccess)).toHaveLength(1);
      expect(capacity.snapshot().payloadBytes).toBe(40);
      expect(capacity.snapshot().activeIds).toHaveLength(1);
    } finally { release.resolve(); capacity.stop(); await runEffect(capacity.drain()); await runEffect(capacity.close()); }
  });
});
