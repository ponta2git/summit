import type { DiscordNotificationReceipt, DiscordResultNotification } from "@momo/db/notifications";
import type { ResultNotificationKind } from "@momo/db";
import type { NotificationStatus, ResultDeliveryError } from "../domain/notification.ts";
import type { ClaimLease } from "../time/lease.ts";
import type { NotificationClaimOptions } from "../domain/notificationClaim.ts";

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
  readonly lease: ClaimLease;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly partCount: number;
  readonly rendererVersion: number | null;
  readonly deliveryContext: ResultDeliveryContext | null;
  /** Sorted, unique delivered part numbers; gaps are permitted. */
  readonly deliveredPartNos: readonly number[];
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
/** Pure validation using fixed configuration; it runs synchronously before DB admission, including duplicates. */
export type ResultNotificationAdmissionCheck = (payload: DiscordResultNotification) => void;

/** Application commands own receipt, cancellation, delivery and retry aggregates. */
export interface ResultNotificationsPort {
  receive(this: void, rawJson: string, now: Date): Promise<DiscordNotificationReceipt>;
  /** The caller subtracts active payloads from its budget and permits oversized history only while idle. */
  claim(this: void, options: NotificationClaimOptions): Promise<readonly ClaimedResultNotification[]>;
  plan(this: void, id: string, token: string, options: {
    readonly count: number; readonly rendererVersion: number; readonly context: ResultDeliveryContext; readonly now: Date;
  }, remainingMs?: () => number): Promise<boolean>;
  begin(this: void, id: string, partNo: number, token: string, now: Date, remainingMs?: () => number): Promise<boolean>;
  complete(this: void, id: string, partNo: number, token: string, messageId: string, now: Date, remainingMs?: () => number): Promise<boolean>;
  /** Release only between completed parts when the other kind is due; a handoff does not consume a retry. */
  yield(this: void, id: string, token: string, now: Date, remainingMs?: () => number): Promise<boolean>;
  fail(this: void, id: string, token: string, error: ResultDeliveryError, nextAttemptAt: Date | null, now: Date, remainingMs?: () => number): Promise<boolean>;
  renew(this: void, id: string, token: string, now: Date, claimDurationMs: number, remainingMs?: () => number): Promise<ClaimLease | null>;
  getNextDispatchAt(this: void, excludeIds?: readonly string[]): Promise<Date | null>;
  inspect(this: void, id: string): Promise<ResultNotificationState | null>;
  retry(this: void, id: string, now: Date): Promise<boolean>;
  prune(this: void, now: Date): Promise<number>;
  getSetting(this: void, kind: ResultNotificationKind): Promise<ResultNotificationSetting>;
  setSetting(this: void, kind: ResultNotificationKind, enabled: boolean, now: Date): Promise<ResultNotificationSetting>;
}
