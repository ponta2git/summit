import { setImmediate } from "node:timers/promises";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import { describe, expect, it, vi } from "vitest";
import { DatabaseError, InvariantViolationError } from "../../src/errors/index.ts";
import { serializeLogError } from "../../src/logger.error.ts";
import {
  catchExpectedError, promiseCall, runPromiseBoundary, runPromiseResultBoundary, settledCall
} from "../../src/runtime/effect.ts";
import { deferred } from "../helpers/deferred.ts";

describe("Effect / Promise boundary", () => {
  it("starts foreign I/O lazily and preserves synchronous and asynchronous failures", async () => {
    const failure = new DatabaseError("unavailable");
    const call = vi.fn(() => { throw failure; });
    const operation = promiseCall(call);
    expect(call).not.toHaveBeenCalled();
    await expect(runPromiseBoundary(operation)).rejects.toBe(failure);
    await expect(runPromiseBoundary(promiseCall(() => Promise.reject(failure)))).rejects.toBe(failure);
    await expect(runPromiseBoundary(Effect.die(failure))).rejects.toBe(failure);
  });

  it("returns expected failures as values while preserving the original error identity", async () => {
    const failure = new DatabaseError("unavailable");
    const call = vi.fn(async () => 42);
    const operation = promiseCall(call);
    expect(call).not.toHaveBeenCalled();
    expect(await runPromiseResultBoundary(operation)).toEqual(Result.succeed(42));
    expect(call).toHaveBeenCalledOnce();
    const result = await runPromiseResultBoundary(Effect.fail(failure));
    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) { throw new Error("Expected a typed failure."); }
    expect(result.failure).toBe(failure);
    await expect(runPromiseResultBoundary(Effect.die(failure))).rejects.toBe(failure);
  });

  it.each([
    { name: "value", run: runPromiseBoundary },
    { name: "result", run: runPromiseResultBoundary }
  ])("rejects a combined operation failure and cleanup defect at the $name boundary", async ({ run }) => {
    const failure = new DatabaseError("private-operation-canary");
    const defect = new Error("private-cleanup-canary");
    const operation = Effect.fail(failure).pipe(Effect.ensuring(Effect.die(defect)));
    const error: unknown = await run(operation).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InvariantViolationError);
    if (!(error instanceof InvariantViolationError) || !Cause.isCause(error.cause)) {
      throw new Error("Expected an invariant error retaining the full cause.");
    }
    expect(error.cause.reasons.filter(Cause.isFailReason).map(reason => reason.error)).toEqual([failure]);
    expect(error.cause.reasons.filter(Cause.isDieReason).map(reason => reason.defect)).toEqual([defect]);
    const diagnostic = JSON.stringify(serializeLogError(error));
    expect(diagnostic).toContain("INVARIANT_VIOLATION");
    expect(diagnostic).not.toContain("private-operation-canary");
    expect(diagnostic).not.toContain("private-cleanup-canary");
  });

  it.each(["interruption", "failure and interruption"] as const)(
    "does not return %s as an expected failure",
    async kind => {
      const interruption = Cause.interrupt();
      const cause = kind === "interruption" ? interruption :
        Cause.combine(Cause.fail(new DatabaseError("unavailable")), interruption);
      const error: unknown = await runPromiseResultBoundary(Effect.failCause(cause)).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error) || !Cause.isCause(error.cause)) {
        throw new Error("Expected an interrupted boundary to retain its cause.");
      }
      expect(Cause.hasInterrupts(error.cause)).toBe(true);
    }
  );

  it("disables raw console diagnostics in the owner and child fibers", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failure = new Error("private-error-canary");
    try {
      await expect(runPromiseBoundary(Effect.gen(function* () {
        yield* Effect.logError(failure);
        const child = yield* Effect.forkChild(Effect.logError(failure));
        yield* Fiber.join(child);
        return yield* Effect.fail(failure);
      }))).rejects.toBe(failure);
      expect(output).not.toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalled();
    } finally { output.mockRestore(); stderr.mockRestore(); }
  });

  it("keeps parallel I/O owned after one call fails until its uncancellable sibling settles", async () => {
    const failed = deferred<never>();
    const blocked = deferred<number>();
    const siblingStarted = deferred<void>();
    const failureObserved = deferred<void>();
    const failure = new DatabaseError("query failed");
    let finished = false;
    const pending = runPromiseBoundary(Effect.all([
      settledCall(() => failed.promise).pipe(Effect.onError(() => Effect.sync(() => failureObserved.resolve()))),
      settledCall(() => { siblingStarted.resolve(); return blocked.promise; })
    ], { concurrency: 2 }));
    const outcome = pending.catch(error => error).finally(() => { finished = true; });
    await siblingStarted.promise;
    failed.reject(failure);
    await failureObserved.promise;
    try {
      await setImmediate();
      expect(finished).toBe(false);
    } finally { blocked.resolve(42); }
    expect(await outcome).toBe(failure);
    expect(finished).toBe(true);
  });

  it("does not release an interrupted owner's resource before a non-cancellable write settles", async () => {
    const started = deferred<void>();
    const write = deferred<void>();
    const events: string[] = [];
    const fiber = Effect.runFork(settledCall(async () => {
      started.resolve();
      await write.promise;
      events.push("committed");
    }).pipe(Effect.ensuring(Effect.sync(() => { events.push("released"); }))));
    await started.promise;
    const interrupted = runPromiseBoundary(Fiber.interrupt(fiber));
    try {
      await setImmediate();
      expect(events).toEqual([]);
    } finally { write.resolve(); }
    await interrupted;
    expect(events).toEqual(["committed", "released"]);
  });
});

describe("expected failure recovery", () => {
  it("recovers a typed failure with its original identity", async () => {
    const failure = new DatabaseError("unavailable");
    const recover = vi.fn((error: DatabaseError) => Effect.succeed(error.code));
    expect(await runPromiseBoundary(catchExpectedError(Effect.fail(failure), recover))).toBe("DATABASE");
    expect(recover).toHaveBeenCalledExactlyOnceWith(failure);
  });

  it.each(["defect", "interruption"] as const)("propagates a %s combined with typed failure without recovery", async kind => {
    const failure = new DatabaseError("unavailable");
    const unexpected = kind === "defect" ? Cause.die(new Error("cleanup failed")) : Cause.interrupt();
    const cause = Cause.combine(Cause.fail(failure), unexpected);
    const recover = vi.fn(() => Effect.void);
    const exit = await runPromiseBoundary(Effect.exit(catchExpectedError(Effect.failCause(cause), recover)));
    expect(recover).not.toHaveBeenCalled();
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) { throw new Error("Expected the entire cause to propagate."); }
    expect(exit.cause.reasons).toEqual(cause.reasons);
  });
});
