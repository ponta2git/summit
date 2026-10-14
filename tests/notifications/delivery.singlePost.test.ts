import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { describe, expect, it, vi } from "vitest";

import { deliverSinglePost, type SinglePostDefinition } from "../../src/notifications/delivery/strategies/singlePost.ts";
import { settledCall } from "../../src/runtime/effect.ts";
import { runEffect } from "../helpers/assertions.ts";
import { deferred } from "../helpers/deferred.ts";

// A new notification can reuse this strategy without an attendance row or a capacity implementation.
const definition = <Receipt>(
  confirmBusiness: SinglePostDefinition<Receipt>["confirmBusiness"],
  confirmDelivery: SinglePostDefinition<Receipt>["confirmDelivery"]
): SinglePostDefinition<Receipt> => ({ nonce: "durable-notification-nonce", confirmBusiness, confirmDelivery });

describe("single-post delivery strategy", () => {
  it("acknowledges only after business confirmation and carries its typed receipt", async () => {
    const confirming = deferred<void>(); const confirmed = deferred<{ canonicalMessageId: string }>();
    const send = vi.fn(async () => ({ id: "accepted" }));
    const acknowledged: Array<{ messageId: string; canonicalMessageId: string }> = [];
    let stopping = false;
    const delivery = runEffect(deliverSinglePost({ body: { content: "notification" }, channel: { send },
      definition: definition(messageId => settledCall(() => {
        expect(messageId).toBe("accepted"); confirming.resolve(); return confirmed.promise;
      }), (messageId, receipt) => Effect.sync(() => { acknowledged.push({ messageId, ...receipt }); }))
    }, { isStopping: () => stopping }));
    try {
      await confirming.promise;
      stopping = true;
      expect(acknowledged).toEqual([]);
      expect(send).toHaveBeenCalledExactlyOnceWith({ content: "notification", nonce: "durable-notification-nonce", enforceNonce: true });
    } finally { confirmed.resolve({ canonicalMessageId: "first-canonical-message" }); await delivery; }
    expect(acknowledged).toEqual([{ messageId: "accepted", canonicalMessageId: "first-canonical-message" }]);
  });

  it("leaves delivery unacknowledged when business confirmation fails after acceptance", async () => {
    const failure = new Error("business confirmation failed");
    const send = vi.fn(async () => ({ id: "accepted" }));
    const acknowledge = vi.fn(() => Effect.void);
    const result = await runEffect(Effect.result(deliverSinglePost({ body: { content: "notification" }, channel: { send },
      definition: definition(() => Effect.fail(failure), acknowledge)
    }, { isStopping: () => false })));
    expect(Result.isFailure(result) && result.failure).toBe(failure);
    expect(send).toHaveBeenCalledOnce();
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it("checks stop at the send boundary without running either confirmation", async () => {
    const send = vi.fn(async () => ({ id: "accepted" }));
    const business = vi.fn(() => Effect.void); const acknowledge = vi.fn(() => Effect.void);
    await runEffect(deliverSinglePost({ body: { content: "notification" }, channel: { send },
      definition: definition(business, acknowledge)
    }, { isStopping: () => true }));
    expect(send).not.toHaveBeenCalled();
    expect(business).not.toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();
  });
});
