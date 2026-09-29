import type { DiscordNotificationReceipt, DiscordResultNotification } from "@momo/db/notifications";
import type { ResultNotificationKind } from "@momo/db";
import type { NotificationStatus, ResultDeliveryError } from "../domain/notification.ts";

export interface ResultDeliveryContext {
  readonly webOrigin: string;
  readonly channelId: string;
}
export interface ResultNotificationPart {
  readonly partNo: number;
  readonly status: "PENDING" | "IN_FLIGHT" | "DELIVERED" | "CANCELLED";
  readonly attemptCount: number;
  readonly deliveredMessageId: string | null;
}
export interface ClaimedResultNotification {
  readonly id: string;
  readonly kind: ResultNotificationKind;
  readonly payload: unknown;
  /** UTF-8 bytes of PostgreSQL's JSONB text, reserved before payload hydration. */
  readonly payloadBytes: number;
  readonly claimToken: string;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly partCount: number;
  readonly rendererVersion: number | null;
  readonly deliveryContext: ResultDeliveryContext | null;
  readonly parts: readonly ResultNotificationPart[];
}
export interface ResultNotificationState {
  readonly notificationId: string;
  readonly sourceJobId: string;
  readonly kind: ResultNotificationKind;
  readonly status: NotificationStatus;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly retryCycle: number;
  readonly nextAttemptAt: Date;
  readonly claimExpiresAt: Date | null;
  readonly cancelReason: string | null;
  readonly lastError: string | null;
  readonly purgedAt: Date | null;
  readonly partCount: number;
  readonly rendererVersion: number | null;
  readonly parts: readonly ResultNotificationPart[];
  readonly retryable: boolean;
}
export interface ResultNotificationSetting {
  readonly kind: ResultNotificationKind;
  readonly enabled: boolean;
  readonly generation: string;
}
export type ResultNotificationAdmissionCheck = (payload: DiscordResultNotification) => void;

/** Application commands own receipt, cancellation, delivery and retry aggregates. */
export interface ResultNotificationsPort {
  receive(rawJson: string, now: Date): Promise<DiscordNotificationReceipt>;
  /** The caller subtracts active payloads from its budget and permits oversized history only while idle. */
  claim(options: { readonly limit: number; readonly now: Date; readonly claimDurationMs: number; readonly excludeIds?: readonly string[];
    readonly payloadBudgetBytes?: number; readonly allowOversizedPayload?: boolean }): Promise<readonly ClaimedResultNotification[]>;
  plan(id: string, token: string, options: {
    readonly count: number; readonly rendererVersion: number; readonly context: ResultDeliveryContext; readonly now: Date;
  }): Promise<boolean>;
  begin(id: string, partNo: number, token: string, now: Date): Promise<boolean>;
  complete(id: string, partNo: number, token: string, messageId: string, now: Date): Promise<boolean>;
  fail(id: string, token: string, error: ResultDeliveryError, nextAttemptAt: Date | null, now: Date): Promise<boolean>;
  renew(id: string, token: string, now: Date, claimDurationMs: number): Promise<boolean>;
  getNextDispatchAt(excludeIds?: readonly string[]): Promise<Date | null>;
  inspect(id: string): Promise<ResultNotificationState | null>;
  retry(id: string, now: Date): Promise<boolean>;
  prune(now: Date): Promise<number>;
  getSetting(kind: ResultNotificationKind): Promise<ResultNotificationSetting>;
  setSetting(kind: ResultNotificationKind, enabled: boolean, now: Date): Promise<ResultNotificationSetting>;
}
