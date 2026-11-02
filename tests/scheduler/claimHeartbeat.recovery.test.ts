import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withClaimHeartbeat, type ClaimOwnership } from "../../src/notifications/delivery/claimHeartbeat.ts";
import type { ClaimLease } from "../../src/time/lease.ts";
import type { Clock } from "../../src/time/index.ts";
import { settledCall } from "../../src/runtime/effect.ts";
import { runEffect } from "../helpers/assertions.ts";
import { deferred } from "../helpers/deferred.ts";

const epoch = Date.parse("2026-09-09T12:00:00Z");
const clock: Clock = { now: () => new Date(), monotonicNow: () => performance.now() };
const leaseAt = (ms = 0, duration = 30_000): ClaimLease => ({
  observedAt: new Date(epoch + ms), observedMonotonicMs: ms, expiresAt: new Date(epoch + ms + duration)
});

describe("claim heartbeat recovery and deadline", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(epoch); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it("pauses new work after a transient error and resumes the same owner after one confirmed retry", async () => {
    const finish = deferred<void>(); const started = deferred<ClaimOwnership>(); const onLost = vi.fn();
    const renew = vi.fn<() => Promise<ClaimLease | null>>().mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce(leaseAt(11_000));
    const delivery = runEffect(withClaimHeartbeat({ lease: leaseAt(), clock, intervalMs: 10_000, renew, onLost }, ownership =>
      settledCall(() => { started.resolve(ownership); return finish.promise; })));
    const owner = await started.promise;
    try {
      await vi.advanceTimersByTimeAsync(10_000);
      expect(owner.state()).toBe("uncertain"); expect(owner.canStart()).toBe(false);
      let allowed = false;
      const wait = runEffect(owner.awaitOwnership()).then(value => { allowed = value; return value; });
      await vi.advanceTimersByTimeAsync(999); expect(allowed).toBe(false); expect(renew).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(await wait).toBe(true); expect(owner.state()).toBe("owned"); expect(renew).toHaveBeenCalledTimes(2);
      expect(onLost).toHaveBeenCalledExactlyOnceWith("uncertain");
    } finally { finish.resolve(); await delivery; }
  });

  it("expires independently of an unresponsive renewal and never revives on its late successful reply", async () => {
    const finish = deferred<void>(); const started = deferred<ClaimOwnership>(); const renewal = deferred<ClaimLease | null>();
    const renew = vi.fn(() => renewal.promise); const onLost = vi.fn();
    let drained = false;
    const delivery = runEffect(withClaimHeartbeat({ lease: leaseAt(), clock, intervalMs: 10_000, renew, onLost }, ownership =>
      settledCall(() => { started.resolve(ownership); return finish.promise; })))
      .then(() => { drained = true; return undefined; });
    const owner = await started.promise;
    try {
      await vi.advanceTimersByTimeAsync(20_000);
      expect(owner.state()).toBe("uncertain"); expect(owner.canStart()).toBe(false);
      const wait = runEffect(owner.awaitOwnership());
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await wait).toBe(false); expect(owner.state()).toBe("lost"); expect(renew).toHaveBeenCalledOnce();
      finish.resolve(); await vi.advanceTimersByTimeAsync(0); expect(drained).toBe(false);
      renewal.resolve(leaseAt(10_000)); await delivery;
      expect(owner.state()).toBe("lost"); expect(owner.canStart()).toBe(false);
      expect(onLost.mock.calls).toEqual([["uncertain"], ["lost"]]);
    } finally { finish.resolve(); renewal.resolve(null); await delivery; }
  });

  it("requests renewal immediately when a delayed claim reply leaves less than one heartbeat of time", async () => {
    await vi.advanceTimersByTimeAsync(21_000);
    const renew = vi.fn(async () => leaseAt(21_000));
    const allowed = runEffect(withClaimHeartbeat({ lease: leaseAt(), clock, intervalMs: 10_000, renew, onLost: vi.fn() }, owner =>
      owner.awaitOwnership()));
    await vi.advanceTimersByTimeAsync(0);
    expect(renew).toHaveBeenCalledOnce();
    expect(await allowed).toBe(true);
  });

  it("blocks new work when a renewal is overdue before its watchdog callback can run", async () => {
    let ms = 0;
    const controlled: Clock = { now: () => new Date(epoch + ms), monotonicNow: () => ms };
    const renewal = deferred<ClaimLease | null>(); const finish = deferred<void>(); const started = deferred<ClaimOwnership>();
    const delivery = runEffect(withClaimHeartbeat({ lease: leaseAt(), clock: controlled, intervalMs: 10_000,
      renew: () => renewal.promise, onLost: vi.fn() }, owner => settledCall(() => { started.resolve(owner); return finish.promise; })));
    const owner = await started.promise;
    try {
      ms = 10_000; await vi.advanceTimersByTimeAsync(10_000);
      ms = 20_000;
      expect(owner.state()).toBe("uncertain"); expect(owner.canStart()).toBe(false);
    } finally { finish.resolve(); renewal.resolve(null); await delivery; }
  });

  it("does not renew or start work when the claim response arrives after its confirmed expiry", async () => {
    await vi.advanceTimersByTimeAsync(30_001);
    const renew = vi.fn(async () => leaseAt(30_001));
    const canStart = await runEffect(withClaimHeartbeat({ lease: leaseAt(), clock, intervalMs: 10_000, renew, onLost: vi.fn() }, owner =>
      owner.awaitOwnership()));
    expect(canStart).toBe(false); expect(renew).not.toHaveBeenCalled();
  });

  it.each([60_000, -60_000])("checks a wall clock jump of %i ms and a synchronous pause before any timer callback", async jump => {
    let wall = epoch; let mono = 0;
    const controlled: Clock = { now: () => new Date(wall), monotonicNow: () => mono };
    const renew = vi.fn(async () => leaseAt());
    const allowed = await runEffect(withClaimHeartbeat({ lease: leaseAt(), clock: controlled, intervalMs: 10_000, renew, onLost: vi.fn() }, owner =>
      Effect.sync(() => { wall += jump; mono += 31_000; return owner.canStart(); })));
    expect(allowed).toBe(false); expect(renew).not.toHaveBeenCalled();
  });

  it("releases an uncertain ownership waiter on stop while still owning the pending DB operation", async () => {
    const stop = new AbortController(); const renewal = deferred<ClaimLease | null>();
    const entered = deferred<void>(); const renew = vi.fn(() => { entered.resolve(); return renewal.promise; });
    let waitResult: boolean | undefined; let drained = false;
    const delivery = runEffect(withClaimHeartbeat({ lease: leaseAt(), clock, intervalMs: 10_000, renew, onLost: vi.fn(), stopSignal: stop.signal }, owner =>
      Effect.gen(function* () {
        yield* Effect.sleep(20_001);
        waitResult = yield* owner.awaitOwnership();
      }))).then(() => { drained = true; return undefined; });
    try {
      await vi.advanceTimersByTimeAsync(20_001); await entered.promise;
      expect(waitResult).toBeUndefined(); stop.abort(); await vi.advanceTimersByTimeAsync(0);
      expect(waitResult).toBe(false); expect(drained).toBe(false); expect(renew).toHaveBeenCalledOnce();
    } finally { stop.abort(); renewal.resolve(null); await delivery; }
  });

  it("bounds settled renewal retries to one, two, and four seconds", async () => {
    const finish = deferred<void>(); const started = deferred<ClaimOwnership>();
    const attempts: number[] = []; const renew = vi.fn(async () => { attempts.push(performance.now()); throw new Error("offline"); });
    const delivery = runEffect(withClaimHeartbeat({ lease: leaseAt(), clock, intervalMs: 10_000, renew, onLost: vi.fn() }, owner =>
      settledCall(() => { started.resolve(owner); return finish.promise; })));
    const owner = await started.promise;
    try {
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      expect(attempts).toEqual([10_000, 11_000, 13_000, 17_000]);
      expect(owner.state()).toBe("lost"); expect(await runEffect(owner.awaitOwnership())).toBe(false);
    } finally { finish.resolve(); await delivery; }
  });
});
