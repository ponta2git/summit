import { describe, expect, it } from "vitest";
import type { ClaimedResultNotification } from "../../src/db/ports.resultNotifications.ts";
import { NotificationInputError } from "../../src/domain/notificationInput.ts";
import { planResultNotification } from "../../src/features/result-notifications/render.ts";
import { prepareResultDelivery } from "../../src/notifications/delivery/definitions/result.ts";
import { analysisNotification } from "../features/result-notifications/fixtures.ts";

const context = { channelId: "channel", webOrigin: "https://results.example.com" };
const claimed = (): ClaimedResultNotification => {
  const payload = analysisNotification();
  return { id: payload.notificationId, kind: payload.kind, payload, payloadBytes: 100,
    claimToken: "claim-token", attemptCount: 1, maxAttempts: 3, partCount: 0,
    rendererVersion: null, deliveryContext: null, deliveredPartNos: [] };
};

describe("result notification definition", () => {
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
