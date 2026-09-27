import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { drainResources, stopResources } from "../../src/runtime/lifecycle.ts";
import { deferred } from "../helpers/deferred.ts";

describe("resource owner cleanup", () => {
  it("stops every producer before reporting a failed stop", () => {
    const failure = new Error("producer stop failed");
    const first = vi.fn(() => { throw failure; });
    const second = vi.fn();
    const third = vi.fn(() => { throw new Error("another stop failed"); });
    const last = vi.fn();
    expect(() => stopResources([first, second, third, last])).toThrow(failure);
    for (const operation of [first, second, third, last]) { expect(operation).toHaveBeenCalledOnce(); }
  });

  it("starts every drain after a synchronous throw and waits for every pending owner", async () => {
    const failure = new Error("drain failed before returning a Promise");
    const pending = deferred<void>();
    const stillRunning = vi.fn(() => pending.promise);
    const last = vi.fn(async () => undefined);
    let completed = false;
    const drained = drainResources([() => { throw failure; }, stillRunning, last])
      .catch(error => error).finally(() => { completed = true; });
    await setImmediate();
    expect(stillRunning).toHaveBeenCalledOnce();
    expect(last).toHaveBeenCalledOnce();
    expect(completed).toBe(false);
    pending.resolve();
    expect(await drained).toBe(failure);
  });
});
