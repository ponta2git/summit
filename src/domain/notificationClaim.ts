import type { ResultNotificationKind } from "@momo/db";

export interface NotificationClaimOptions {
  readonly limit: number;
  readonly now: Date;
  readonly claimDurationMs: number;
  readonly excludeIds?: readonly string[];
  readonly payloadBudgetBytes?: number;
  readonly allowOversizedPayload?: boolean;
  readonly preferredKind?: ResultNotificationKind;
}

/** Validate bounded claim work before either the database or fake changes state. */
export const assertNotificationClaimOptions = (options: NotificationClaimOptions): void => {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100
    || !Number.isSafeInteger(options.claimDurationMs) || options.claimDurationMs < 1 || options.claimDurationMs > 300_000
    || (options.payloadBudgetBytes !== undefined && (!Number.isSafeInteger(options.payloadBudgetBytes) || options.payloadBudgetBytes < 0))) {
    throw new Error("Invalid notification claim options");
  }
};

/** Historical payloads may exceed the byte budget only in an otherwise empty batch. */
export const notificationPayloadFitsClaim = (
  payloadBytes: number, remainingBytes: number, claimedCount: number, allowOversizedPayload?: boolean
): boolean => payloadBytes <= remainingBytes || (claimedCount === 0 && (allowOversizedPayload ?? true));
