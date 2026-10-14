import type { ClaimedResultNotification, ResultDeliveryContext } from "../../../db/ports.resultNotifications.ts";
import { validateStoredNotification } from "../../../domain/resultNotificationPayload.ts";
import { NotificationInputError } from "../../../domain/notificationInput.ts";
import { planResultNotification, type PlannedResultNotification } from "../../../features/result-notifications/render.ts";

type ResultDeliveryMetadata = Pick<ClaimedResultNotification, "id" | "kind" | "claimToken" | "attemptCount" | "maxAttempts">;
export type PreparedResultDelivery = { readonly metadata: ResultDeliveryMetadata } & ({
  readonly strategy: "resumable";
  readonly notification: PlannedResultNotification;
  readonly context: ResultDeliveryContext;
  readonly deliveredPartNos: readonly number[];
} | { readonly strategy: "rejected"; readonly error: "unsupported_renderer" | "invalid_payload" });

/** Validate synchronously; the retained plan and metadata never capture the claimed raw payload. */
export const prepareResultDelivery = (entry: ClaimedResultNotification, currentContext: ResultDeliveryContext): PreparedResultDelivery => {
  const metadata: ResultDeliveryMetadata = {
    id: entry.id, kind: entry.kind, claimToken: entry.claimToken, attemptCount: entry.attemptCount, maxAttempts: entry.maxAttempts
  };
  const context = entry.partCount === 0 ? currentContext : entry.deliveryContext;
  const rendererVersion = entry.kind === "ocr_completed" ? 2 : 1;
  if (!context || (entry.rendererVersion !== null && entry.rendererVersion !== rendererVersion)) {
    return { metadata, strategy: "rejected", error: "unsupported_renderer" };
  }
  let notification: PlannedResultNotification;
  try {
    const payload = validateStoredNotification(entry.payload);
    if (payload.kind !== entry.kind) { return { metadata, strategy: "rejected", error: "invalid_payload" }; }
    notification = planResultNotification(payload, context.webOrigin, entry.rendererVersion ?? rendererVersion);
  } catch (error: unknown) {
    if (error instanceof NotificationInputError) { return { metadata, strategy: "rejected", error: "invalid_payload" }; }
    throw error;
  }
  if (entry.partCount > 0 && notification.partCount !== entry.partCount) {
    return { metadata, strategy: "rejected", error: "unsupported_renderer" };
  }
  return { metadata, strategy: "resumable", notification, context: { ...context }, deliveredPartNos: [...entry.deliveredPartNos] };
};
