import { describe, expect, it, vi } from "vitest";
import type { ClaimedResultNotification } from "../../src/db/ports.resultNotifications.ts";
import { NotificationInputError } from "../../src/domain/notificationInput.ts";
import { planResultNotification } from "../../src/features/result-notifications/render.ts";
import { prepareResultDelivery, resultNotificationDefinitions, type ResultNotificationDefinitions } from "../../src/notifications/delivery/definitions/result.ts";
import { analysisNotification } from "../features/result-notifications/fixtures.ts";

const context = { channelId: "channel", webOrigin: "https://results.example.com" };
const claimed = (): ClaimedResultNotification => {
  const payload = analysisNotification();
  return { id: payload.notificationId, kind: payload.kind, payload, payloadBytes: 100,
    claimToken: "claim-token", attemptCount: 1, maxAttempts: 3, partCount: 0,
    rendererVersion: null, deliveryContext: null, deliveredPartNos: [] };
};

describe("result notification definition", () => {
  it("uses an injected definition's renderer and version while detaching the validated payload from the claimed object", () => {
    const original = analysisNotification();
    const raw = { ...original, data: { ...original.data, gameTitleName: "Registered title" } };
    const renderer: ResultNotificationDefinitions["analysis_completed"]["renderer"] = {
      rendererVersion: 7,
      plan: vi.fn((payload, webOrigin) => ({ rendererVersion: 7, partCount: 1,
        *parts() { yield { content: `${payload.data.gameTitleName}: ${webOrigin}` }; }
      }))
    };
    const definitions: ResultNotificationDefinitions = {
      ...resultNotificationDefinitions, analysis_completed: { strategy: "resumable", renderer }
    };
    const prepared = prepareResultDelivery({ ...claimed(), payload: raw }, context, definitions);
    raw.data.gameTitleName = "Mutated raw payload";
    expect(prepared.strategy).toBe("resumable");
    if (prepared.strategy === "rejected") { throw new Error("Expected the registered renderer"); }
    expect(prepared.notification.rendererVersion).toBe(7);
    expect([...prepared.notification.parts()]).toEqual([{ content: "Registered title: https://results.example.com" }]);
    expect(renderer.plan).toHaveBeenCalledOnce();
  });

  it("retains stored renderer and context checks when a definition is replaced", () => {
    const renderer: ResultNotificationDefinitions["analysis_completed"]["renderer"] = {
      rendererVersion: 7,
      plan: vi.fn((_payload, webOrigin) => ({ rendererVersion: 7, partCount: 1,
        *parts() { yield { content: webOrigin }; }
      }))
    };
    const definitions: ResultNotificationDefinitions = {
      ...resultNotificationDefinitions, analysis_completed: { strategy: "resumable", renderer }
    };
    const persisted = { ...claimed(), partCount: 1, rendererVersion: 7, deliveryContext: context };
    const currentContext = { channelId: "new-channel", webOrigin: "https://new.example.com" };
    const prepared = prepareResultDelivery(persisted, currentContext, definitions);
    if (prepared.strategy === "rejected") { throw new Error("Expected the retained renderer"); }
    expect(prepared.context).toEqual(context);
    expect([...prepared.notification.parts()]).toEqual([{ content: "https://results.example.com" }]);
    expect(prepareResultDelivery({ ...persisted, rendererVersion: 1 }, currentContext, definitions))
      .toMatchObject({ strategy: "rejected", error: "unsupported_renderer" });
    expect(prepareResultDelivery({ ...persisted, deliveryContext: null }, currentContext, definitions))
      .toMatchObject({ strategy: "rejected", error: "unsupported_renderer" });
    expect(prepareResultDelivery({ ...persisted, partCount: 2 }, currentContext, definitions))
      .toMatchObject({ strategy: "rejected", error: "unsupported_renderer" });
    expect(renderer.plan).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid payloads and a validated payload whose kind disagrees with its claimed metadata", () => {
    const entry = claimed();
    expect(prepareResultDelivery({ ...entry, payload: {} }, context)).toMatchObject({ strategy: "rejected", error: "invalid_payload" });
    expect(prepareResultDelivery({ ...entry, kind: "ocr_completed" }, context)).toMatchObject({ strategy: "rejected", error: "invalid_payload" });
    expect(prepareResultDelivery({ ...entry, rendererVersion: 99 }, context)).toMatchObject({ strategy: "rejected", error: "unsupported_renderer" });
  });

  it("propagates unexpected preparation defects and invalid configuration instead of rejecting the payload", () => {
    const defect = new TypeError("Unexpected preparation invariant");
    const entry = { ...claimed(), get payload(): unknown { throw defect; } };
    expect(() => prepareResultDelivery(entry, context)).toThrow(defect);
    expect(() => prepareResultDelivery(claimed(), { ...context, webOrigin: "https://results.example.com/private-path" }))
      .toThrow("application origin");
  });

  it("keeps the historical part ceiling an expected payload rejection", () => {
    const original = analysisNotification();
    const payload = { ...original, data: { ...original.data, gameTitleName: "x".repeat(1_900 * 10_000) } };
    expect(() => planResultNotification(payload, context.webOrigin)).toThrow(new NotificationInputError("payload_too_large"));
    expect(prepareResultDelivery({ ...claimed(), payload }, context)).toMatchObject({ strategy: "rejected", error: "invalid_payload" });
  });
});
