import { and, eq, or, sql } from "drizzle-orm";
import { RESULT_NOTIFICATION_MAX_JSONB_BYTES, RESULT_NOTIFICATION_MAX_OCR_JSONB_BYTES } from "../../notifications/config.ts";
import type { DiscordNotificationReceipt } from "@momo/db/notifications";
import { NotificationInputError } from "../../domain/resultNotificationPayload.ts";
import { discordNotifications as notifications, discordNotificationResults as results, discordNotificationTargets as targets } from "../schema.ts";
import { cancelNotification, loadResultCancellationReason, type NotificationDb } from "./notifications.storage.ts";
import { normalizeNotificationJson } from "./notifications.hash.ts";
import { assertEnum } from "../rows.ts";
import { preparedReceiptValue, type PreparedReceipt } from "./resultNotifications.prepare.ts";

export const receiveResultNotification = async (
  tx: NotificationDb, prepared: PreparedReceipt, now: Date
): Promise<DiscordNotificationReceipt> => {
  const { rawJson } = prepared;
  const identity = preparedReceiptValue(prepared.identity);
  const [existing] = await tx.select({
    id: notifications.id, family: notifications.family, hash: notifications.payloadHash, status: notifications.status
  }).from(notifications).leftJoin(results, eq(results.notificationId, notifications.id))
    .where(or(eq(notifications.id, identity.notificationId),
      and(eq(results.kind, identity.kind), eq(results.sourceJobId, identity.sourceJobId)))).limit(1);
  if (existing) {
    // A new admission policy cannot rewrite a retained identity, including one
    // whose payload was purged. Keep the historical lossless hash for duplicates.
    const normalized = await normalizeNotificationJson(tx, rawJson);
    if (existing.id !== identity.notificationId || existing.family !== "result" || existing.hash !== normalized.hash) {
      throw new NotificationInputError("identity_conflict");
    }
    return { notificationId: existing.id, disposition: "duplicate",
      status: assertEnum(["PENDING", "IN_FLIGHT", "DELIVERED", "FAILED", "CANCELLED"] as const, existing.status, "notification status") };
  }
  if (!prepared.newAdmission) { throw new Error("Missing notification admission result"); }
  if (prepared.newAdmission.outcome !== "ready" && prepared.newAdmission.stage === "admission") {
    preparedReceiptValue(prepared.newAdmission);
  }
  const maximumBytes = identity.kind === "ocr_completed" ? RESULT_NOTIFICATION_MAX_OCR_JSONB_BYTES : RESULT_NOTIFICATION_MAX_JSONB_BYTES;
  const normalized = await normalizeNotificationJson(tx, rawJson, maximumBytes);
  const payload = preparedReceiptValue(prepared.newAdmission);
  await tx.insert(notifications).values({
    id: payload.notificationId, family: "result", kind: payload.kind, dedupeKey: payload.notificationId,
    payload: sql`${normalized.text}::jsonb`, payloadHash: normalized.hash, schemaVersion: payload.schemaVersion,
    createdAt: now, updatedAt: now, nextAttemptAt: now
  });
  await tx.insert(results).values({
    notificationId: payload.notificationId, kind: payload.kind, sourceJobId: payload.sourceJobId,
    occurredAt: payload.occurredAt, settingsGeneration: payload.settingsGeneration
  });
  const references = payload.targetIds.map(targetId => ({ notificationId: payload.notificationId, targetKind: payload.targetKind, targetId }));
  for (let offset = 0; offset < references.length; offset += 1_000) {
    await tx.insert(targets).values(references.slice(offset, offset + 1_000));
  }
  const reason = await loadResultCancellationReason(tx, payload.notificationId);
  if (reason) {
    await cancelNotification(tx, payload.notificationId, reason, now);
    return { notificationId: payload.notificationId, disposition: "cancelled", status: "CANCELLED" };
  }
  return { notificationId: payload.notificationId, disposition: "accepted", status: "PENDING" };
};
