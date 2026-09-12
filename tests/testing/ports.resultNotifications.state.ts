import type { DiscordResultNotification } from "@momo/db/notifications";
import type { ResultNotificationKind } from "@momo/db";
import type { ResultDeliveryContext, ResultNotificationPart, ResultNotificationSetting } from "../../src/db/ports.resultNotifications.ts";
import { resultCancellationReason, type NotificationStatus } from "../../src/domain/notification.ts";

export interface FakeResultEntry {
  id: string;
  kind: ResultNotificationKind;
  sourceJobId: string;
  identity: string;
  payload: DiscordResultNotification | null;
  status: NotificationStatus;
  attemptCount: number;
  maxAttempts: number;
  retryCycle: number;
  claimToken: string | null;
  claimExpiresAt: Date | null;
  nextAttemptAt: Date;
  terminalAt: Date | null;
  purgedAt: Date | null;
  cancelReason: string | null;
  lastError: string | null;
  partCount: number;
  rendererVersion: number | null;
  deliveryContext: ResultDeliveryContext | null;
  parts: ResultNotificationPart[];
}

// The fake compares JSON values. PostgreSQL's lossless numeric/hash wire contract
// is exercised separately against real DB, including decimals beyond JS precision.
export const semanticJson = (value: unknown): string => {
  if (Array.isArray(value)) { return `[${value.map(semanticJson).join(", ")}]`; }
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value).sort(([a], [b]) => Buffer.byteLength(a) - Buffer.byteLength(b) || Buffer.compare(Buffer.from(a), Buffer.from(b)))
      .map(([key, child]) => `${JSON.stringify(key)}: ${semanticJson(child)}`).join(", ")}}`;
  }
  return JSON.stringify(value);
};

export const createFakeResultState = () => {
  const entries = new Map<string, FakeResultEntry>();
  const settings = new Map<ResultNotificationKind, ResultNotificationSetting>([
    ["ocr_completed", { kind: "ocr_completed", enabled: true, generation: "0" }],
    ["analysis_completed", { kind: "analysis_completed", enabled: true, generation: "0" }]
  ]);
  const available = new Set<string>();
  const cancel = (entry: FakeResultEntry, reason: string, now: Date): void => {
    if (entry.status === "DELIVERED" || entry.status === "CANCELLED" || entry.purgedAt) { return; }
    entry.status = "CANCELLED"; entry.cancelReason = reason; entry.terminalAt = now;
    entry.parts = entry.parts.map(part => part.status === "PENDING" ? { ...part, status: "CANCELLED" } : part);
    if (!entry.parts.some(part => part.status === "IN_FLIGHT")) { entry.claimToken = null; entry.claimExpiresAt = null; }
  };
  const reason = (entry: FakeResultEntry): string | null => {
    const payload = entry.payload;
    const setting = settings.get(entry.kind);
    if (!payload || !setting) { return null; }
    return resultCancellationReason({ enabled: setting.enabled, currentGeneration: BigInt(setting.generation),
      receivedGeneration: BigInt(payload.settingsGeneration),
      unavailableDraft: payload.kind === "ocr_completed" && !available.has(`match_draft:${payload.data.matchDraftId}`),
      deletedMatch: payload.kind === "analysis_completed" && payload.data.matches.some(match => !available.has(`match:${match.matchId}`))
    });
  };
  return { entries, settings, available, cancel, reason };
};
