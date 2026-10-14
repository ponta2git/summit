import type { ClaimedResultNotification, ResultDeliveryContext } from "../../../db/ports.resultNotifications.ts";
import { validateStoredNotification } from "../../../domain/resultNotificationPayload.ts";
import { NotificationInputError } from "../../../domain/notificationInput.ts";
import {
  resultNotificationRenderers, type PlannedResultNotification, type ResultNotificationPayloads, type ResultNotificationRenderer
} from "../../../features/result-notifications/render.ts";

interface ResultNotificationDefinition<Kind extends keyof ResultNotificationPayloads> {
  readonly strategy: "resumable";
  readonly renderer: ResultNotificationRenderer<ResultNotificationPayloads[Kind]>;
}

export type ResultNotificationDefinitions = {
  readonly [Kind in keyof ResultNotificationPayloads]: ResultNotificationDefinition<Kind>;
};

/** Existing result kinds share a delivery method while retaining their own renderer contracts. */
export const resultNotificationDefinitions: ResultNotificationDefinitions = {
  ocr_completed: { strategy: "resumable", renderer: resultNotificationRenderers.ocr_completed },
  analysis_completed: { strategy: "resumable", renderer: resultNotificationRenderers.analysis_completed }
};

const selectDefinition = <Kind extends keyof ResultNotificationPayloads>(
  definitions: ResultNotificationDefinitions, kind: Kind
): ResultNotificationDefinition<Kind> => definitions[kind];

type ResultDeliveryMetadata = Pick<ClaimedResultNotification, "id" | "kind" | "claimToken" | "attemptCount" | "maxAttempts">;
export type PreparedResultDelivery = { readonly metadata: ResultDeliveryMetadata } & ({
  readonly strategy: "resumable";
  readonly notification: PlannedResultNotification;
  readonly context: ResultDeliveryContext;
  readonly deliveredPartNos: readonly number[];
} | { readonly strategy: "rejected"; readonly error: "unsupported_renderer" | "invalid_payload" });

/** Validate synchronously; the retained plan and metadata never capture the claimed raw payload. */
export const prepareResultDelivery = (
  entry: ClaimedResultNotification, currentContext: ResultDeliveryContext,
  definitions: ResultNotificationDefinitions = resultNotificationDefinitions
): PreparedResultDelivery => {
  const metadata: ResultDeliveryMetadata = {
    id: entry.id, kind: entry.kind, claimToken: entry.claimToken, attemptCount: entry.attemptCount, maxAttempts: entry.maxAttempts
  };
  const context = entry.partCount === 0 ? currentContext : entry.deliveryContext;
  const definition = selectDefinition(definitions, entry.kind);
  const { rendererVersion } = definition.renderer;
  if (!context || (entry.rendererVersion !== null && entry.rendererVersion !== rendererVersion)) {
    return { metadata, strategy: "rejected", error: "unsupported_renderer" };
  }
  let notification: PlannedResultNotification;
  try {
    const payload = validateStoredNotification(entry.payload);
    if (payload.kind !== entry.kind) { return { metadata, strategy: "rejected", error: "invalid_payload" }; }
    notification = definition.renderer.plan(payload, context.webOrigin);
  } catch (error: unknown) {
    if (error instanceof NotificationInputError) { return { metadata, strategy: "rejected", error: "invalid_payload" }; }
    throw error;
  }
  if (entry.partCount > 0 && notification.partCount !== entry.partCount) {
    return { metadata, strategy: "rejected", error: "unsupported_renderer" };
  }
  return { metadata, strategy: definition.strategy, notification, context: { ...context }, deliveredPartNos: [...entry.deliveredPartNos] };
};
