import { Effect, Fiber } from "effect";
import { describe, expect, it, vi } from "vitest";
import { DatabaseError } from "../../src/errors/index.ts";
import { promiseCall, runPromiseBoundary, settledCall } from "../../src/runtime/effect.ts";
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
    expect(finished).toBe(false);
    blocked.resolve(42);
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
    expect(events).toEqual([]);
    write.resolve();
    await interrupted;
    expect(events).toEqual(["committed", "released"]);
  });
});
