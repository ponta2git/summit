import type { ResultNotificationKind } from "@momo/db";
import type { ResultNotificationAdmissionCheck } from "../ports.resultNotifications.ts";
import {
  NotificationInputError, assertSupportedNotificationVersion, parseNotificationJson,
  readNotificationIdentity, validateNewNotification
} from "../../domain/resultNotificationPayload.ts";
import { parseTimestamp } from "../../time/index.ts";

type Stage = "identity" | "admission" | "metadata";
type PreparationFailure = { readonly outcome: "expected"; readonly stage: Stage; readonly code: NotificationInputError["code"] }
  | { readonly outcome: "unexpected"; readonly stage: Stage };
export type PreparedValue<T> = { readonly outcome: "ready"; readonly value: T } | PreparationFailure;
interface NewReceiptMetadata {
  readonly notificationId: string;
  readonly sourceJobId: string;
  readonly kind: ResultNotificationKind;
  readonly schemaVersion: number;
  readonly occurredAt: Date;
  readonly settingsGeneration: bigint;
  readonly targetKind: "match" | "match_draft";
  readonly targetIds: readonly string[];
}
export interface PreparedReceipt {
  readonly rawJson: string;
  readonly identity: PreparedValue<ReturnType<typeof readNotificationIdentity>>;
  readonly newAdmission: PreparedValue<NewReceiptMetadata> | null;
}

const failure = (error: unknown, stage: Stage): PreparationFailure => error instanceof NotificationInputError
  ? { outcome: "expected", stage, code: error.code } : { outcome: "unexpected", stage };

/** Parse, validate and project in one synchronous frame; never retain a tree, renderer or original exception. */
export const prepareResultReceipt = (rawJson: string, admissionCheck: ResultNotificationAdmissionCheck): PreparedReceipt => {
  let stage: Stage = "identity";
  let identity: ReturnType<typeof readNotificationIdentity> | undefined;
  try {
    const value = parseNotificationJson(rawJson);
    identity = readNotificationIdentity(value);
    assertSupportedNotificationVersion(value);
    stage = "admission";
    const payload = validateNewNotification(value);
    admissionCheck(payload);
    stage = "metadata";
    const occurredAt = parseTimestamp(payload.occurredAt);
    if (!occurredAt) { throw new NotificationInputError("invalid_input"); }
    const metadata: NewReceiptMetadata = {
      notificationId: payload.notificationId, sourceJobId: payload.sourceJobId, kind: payload.kind,
      schemaVersion: payload.schemaVersion, occurredAt, settingsGeneration: BigInt(payload.settingsGeneration),
      targetKind: payload.kind === "ocr_completed" ? "match_draft" : "match",
      targetIds: payload.kind === "ocr_completed" ? [payload.data.matchDraftId] : payload.data.matches.map(match => match.matchId)
    };
    return { rawJson, identity: { outcome: "ready", value: identity }, newAdmission: { outcome: "ready", value: metadata } };
  } catch (error: unknown) {
    const result = failure(error, stage);
    return stage === "identity" || !identity
      ? { rawJson, identity: result, newAdmission: null }
      : { rawJson, identity: { outcome: "ready", value: identity }, newAdmission: result };
  }
};

/** Apply a recorded result only at its original transactional stage. */
export const preparedReceiptValue = <T>(result: PreparedValue<T>): T => {
  if (result.outcome === "ready") { return result.value; }
  if (result.outcome === "expected") { throw new NotificationInputError(result.code); }
  throw new Error("Notification receipt preparation failed.");
};
