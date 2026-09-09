export type NotificationStatus = "PENDING" | "IN_FLIGHT" | "DELIVERED" | "FAILED" | "CANCELLED";
export type ResultCancellationReason = "setting_off" | "stale_generation" | "draft_unavailable" | "match_deleted";

/** The application defines which changes invalidate the whole notification. */
export const resultCancellationReason = (context: {
  readonly enabled: boolean;
  readonly currentGeneration: bigint;
  readonly receivedGeneration: bigint;
  readonly unavailableDraft: boolean;
  readonly deletedMatch: boolean;
}): ResultCancellationReason | null => {
  if (!context.enabled) { return "setting_off"; }
  if (context.currentGeneration !== context.receivedGeneration) { return "stale_generation"; }
  if (context.unavailableDraft) { return "draft_unavailable"; }
  if (context.deletedMatch) { return "match_deleted"; }
  return null;
};

export const ownsNotificationClaim = (notification: {
  readonly status: string;
  readonly claimToken: string | null;
  readonly claimExpiresAt: Date | null;
}, token: string, now: Date, allowCancelled = false): boolean =>
  (notification.status === "IN_FLIGHT" || (allowCancelled && notification.status === "CANCELLED"))
  && notification.claimToken === token && notification.claimExpiresAt !== null
  && notification.claimExpiresAt > now;

export const afterDeliveryFailure = (notification: {
  readonly status: string;
  readonly attemptCount: number;
  readonly maxAttempts: number;
}, retry: boolean): "CANCELLED" | "FAILED" | "PENDING" => {
  if (notification.status === "CANCELLED") { return "CANCELLED"; }
  return !retry || notification.attemptCount >= notification.maxAttempts ? "FAILED" : "PENDING";
};

export const RESULT_DELIVERY_ERRORS = [
  "discord_unavailable", "discord_rate_limited", "delivery_uncertain", "invalid_payload",
  "unsupported_renderer", "delivery_failed", "attempt_limit"
] as const;
export type ResultDeliveryError = typeof RESULT_DELIVERY_ERRORS[number];
