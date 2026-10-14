import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createResultNotificationDispatcher } from "../../src/notifications/delivery/composition.result.ts";
import { prepareResultDelivery, resultNotificationDefinitions, type ResultNotificationDefinitions } from "../../src/notifications/delivery/definitions/result.ts";
import { deliverResumable, type ResumableStrategy } from "../../src/notifications/delivery/strategies/resumable.ts";
import { notificationNow } from "../contracts/resultNotifications.ts";
import { resultWorkerHarness } from "../scheduler/resultNotifications.harness.ts";

describe("result delivery composition", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(notificationNow); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it("delivers a replaced definition through the injected strategy and the real dispatcher ownership path", async () => {
    const h = resultWorkerHarness(); const id = await h.enqueue("registered-definition", "Original payload");
    const definitions: ResultNotificationDefinitions = {
      ...resultNotificationDefinitions,
      analysis_completed: { strategy: "resumable", renderer: {
        rendererVersion: 7,
        plan: (notification, webOrigin) => ({ rendererVersion: 7, partCount: 2, *parts() {
          yield { content: `Registered result: ${notification.sourceJobId}` };
          yield { content: `Registered link: ${webOrigin}` };
        } })
      } }
    };
    const strategies: number[] = [];
    const strategy: ResumableStrategy = delivery => Effect.suspend(() => {
      strategies.push(delivery.partCount);
      return deliverResumable(delivery);
    });
    const dispatcher = createResultNotificationDispatcher({ ...h, strategy,
      prepareNotification: (entry, context) => prepareResultDelivery(entry, context, definitions)
    });
    try {
      expect(h.channel.send).not.toHaveBeenCalled();
      dispatcher.wake("receipt");
      expect(h.channel.send).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(0);
      await dispatcher.drain();
      expect(strategies).toEqual([2]);
      expect(h.channel.send.mock.calls.map(([body]) => body.content)).toEqual([
        "Registered result: registered-definition", "Registered link: https://momo.example.com"
      ]);
      expect(await h.port.inspect(id)).toMatchObject({ status: "DELIVERED", attemptCount: 1, rendererVersion: 7, partCount: 2,
        parts: [
          { partNo: 0, status: "DELIVERED", deliveredMessageId: "message-1" },
          { partNo: 1, status: "DELIVERED", deliveredMessageId: "message-2" }
        ]
      });
      expect(h.logger.error).not.toHaveBeenCalled();
    } finally { dispatcher.stop(); await dispatcher.drain(); }
  });
});
