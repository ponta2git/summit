import { setImmediate } from "node:timers/promises";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseError } from "../../src/errors/index.ts";
import { settledCall } from "../../src/runtime/effect.ts";
import { withClaimHeartbeat } from "../../src/notifications/delivery/claimHeartbeat.ts";
import { runEffect } from "../helpers/assertions.ts";
import { deferred } from "../helpers/deferred.ts";

describe("claim heartbeat ownership", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it.each(["lost", "uncertain"] as const)("closes ownership before a %s diagnostic throws and observes the child failure", async reason => {
    const started = deferred<void>();
    const delivery = deferred<void>();
    const diagnosticFailure = new Error("diagnostic failed");
    let isClaimLost = () => false;
    let lostDuringDiagnostic = false;
    let settled = false;
    let nextSendStarted = false;
    const renew = vi.fn(() => reason === "lost" ? Promise.resolve(false) : Promise.reject(new Error("renew failed")));
    const pending = runEffect(Effect.exit(withClaimHeartbeat({ intervalMs: 10, renew,
      onLost: actual => {
        expect(actual).toBe(reason);
        lostDuringDiagnostic = isClaimLost();
        throw diagnosticFailure;
      }
    }, readLost => {
      isClaimLost = readLost;
      return Effect.gen(function* () {
        yield* settledCall(() => { started.resolve(); return delivery.promise; });
        if (!readLost()) { nextSendStarted = true; }
      });
    }))).then(exit => { settled = true; return exit; });
    try {
      await started.promise;
      await vi.advanceTimersByTimeAsync(10);
      expect(lostDuringDiagnostic).toBe(true);
      expect(isClaimLost()).toBe(true);
      expect(settled).toBe(false);
    } finally { delivery.resolve(); }
    const exit = await pending;
    expect(nextSendStarted).toBe(false);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isSuccess(exit)) { throw new Error("Expected the heartbeat defect to reach its owner."); }
    expect(Cause.hasDies(exit.cause)).toBe(true);
    expect(Cause.squash(exit.cause)).toBe(diagnosticFailure);
    await vi.advanceTimersByTimeAsync(30);
    expect(renew).toHaveBeenCalledOnce();
  });

  it("preserves both delivery failure and a concurrent heartbeat defect", async () => {
    const started = deferred<void>(); const delivery = deferred<void>();
    const failure = new DatabaseError("delivery failed"); const defect = new Error("diagnostic failed");
    const pending = runEffect(Effect.exit(withClaimHeartbeat({ intervalMs: 10,
      renew: () => Promise.resolve(false), onLost: () => { throw defect; }
    }, () => settledCall(() => { started.resolve(); return delivery.promise; }))));
    try {
      await started.promise;
      await vi.advanceTimersByTimeAsync(10);
    } finally { delivery.reject(failure); }
    const exit = await pending;
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isSuccess(exit)) { throw new Error("Expected delivery and heartbeat failures."); }
    expect(Cause.hasFails(exit.cause)).toBe(true);
    expect(Cause.hasDies(exit.cause)).toBe(true);
    expect(exit.cause.reasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ _tag: "Fail", error: failure }),
      expect.objectContaining({ _tag: "Die", defect })
    ]));
  });

  it.each(["success", "failure", "interruption"] as const)("retains a pending renewal through delivery %s", async mode => {
    const started = deferred<void>();
    const delivery = deferred<void>();
    const renewing = deferred<void>();
    const renewal = deferred<boolean>();
    const failure = new DatabaseError("delivery failed");
    const controller = new AbortController();
    const onLost = vi.fn();
    const renew = vi.fn(() => { renewing.resolve(); return renewal.promise; });
    let settled = false;
    const pending = Effect.runPromiseExit(withClaimHeartbeat({ intervalMs: 10, renew, onLost }, () =>
      settledCall(() => { started.resolve(); return delivery.promise; })
    ), { signal: controller.signal }).then(exit => { settled = true; return exit; });
    try {
      await started.promise;
      await vi.advanceTimersByTimeAsync(10);
      await renewing.promise;
      if (mode === "interruption") { controller.abort(); }
      if (mode === "failure") { delivery.reject(failure); }
      else { delivery.resolve(); }
      await setImmediate();
      expect(settled).toBe(false);
    } finally { delivery.resolve(); renewal.resolve(false); }
    const exit = await pending;
    expect(Exit.isSuccess(exit)).toBe(mode === "success");
    const interrupted = Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause);
    const error = Exit.isFailure(exit) && !interrupted ? Cause.squash(exit.cause) : undefined;
    expect(interrupted).toBe(mode === "interruption");
    expect(error).toBe(mode === "failure" ? failure : undefined);
    expect(onLost).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30);
    expect(renew).toHaveBeenCalledOnce();
  });
});
