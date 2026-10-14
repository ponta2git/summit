import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { describe, expect, it, vi } from "vitest";
import { deliverResumable } from "../../src/notifications/delivery/strategies/resumable.ts";
import { promiseCall } from "../../src/runtime/effect.ts";
import { runEffect } from "../helpers/assertions.ts";
import { deferred } from "../helpers/deferred.ts";

const deliveryHarness = () => {
  const events: string[] = [];
  return { events, parts: () => ["first", "second", "third", "fourth"], partCount: 4, deliveredPartNos: [0, 2],
    shouldStop: () => false,
    begin: (part: number) => Effect.sync(() => { events.push(`begin:${part}`); return true; }),
    send: (part: number, body: string) => Effect.sync(() => { events.push(`send:${part}:${body}`); return `message-${part}`; }),
    complete: (part: number, id: string) => Effect.sync(() => { events.push(`complete:${part}:${id}`); return true; }),
    consumeYieldRequest: () => false,
    yield: () => Effect.sync(() => { events.push("yield"); return true; })
  };
};

describe("resumable delivery strategy", () => {
  it("resumes missing parts in order without replaying delivered gaps", async () => {
    const h = deliveryHarness();
    await runEffect(deliverResumable(h));
    expect(h.events).toEqual([
      "begin:1", "send:1:second", "complete:1:message-1",
      "begin:3", "send:3:fourth", "complete:3:message-3"
    ]);
  });

  it("waits for durable completion before consuming a yield request and starting no later part", async () => {
    const h = deliveryHarness(); const completing = deferred<void>(); const complete = deferred<boolean>();
    const consume = vi.fn(() => true);
    const pending = runEffect(deliverResumable<string, unknown>({ ...h, consumeYieldRequest: consume,
      complete: () => promiseCall(() => { completing.resolve(); return complete.promise; })
    }));
    await completing.promise;
    expect(h.events).toEqual(["begin:1", "send:1:second"]);
    expect(consume).not.toHaveBeenCalled();
    complete.resolve(true); await pending;
    expect(h.events).toEqual(["begin:1", "send:1:second", "yield"]);
    expect(consume).toHaveBeenCalledOnce();
  });

  it("records a started send when stopping and propagates interruption without completion", async () => {
    const h = deliveryHarness(); let stopping = false;
    await runEffect(deliverResumable({ ...h, shouldStop: () => stopping,
      send: () => Effect.sync(() => { stopping = true; return "known-message"; })
    }));
    expect(h.events).toEqual(["begin:1", "complete:1:known-message"]);
    const interrupted = deliveryHarness();
    const exit = await runEffect(Effect.exit(deliverResumable({ ...interrupted, send: () => Effect.interrupt })));
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) { throw new Error("Expected interruption"); }
    expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    expect(interrupted.events).toEqual(["begin:1"]);
  });
});
