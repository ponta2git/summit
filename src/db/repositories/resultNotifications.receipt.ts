import { and, eq, or, sql } from "drizzle-orm";
import { RESULT_NOTIFICATION_MAX_JSONB_BYTES } from "../../config.ts";
import type { DiscordNotificationReceipt } from "@momo/db/notifications";
import { NotificationInputError, readNotificationIdentity, validateNewNotification } from "../../domain/resultNotificationPayload.ts";
import { parseTimestamp } from "../../time/index.ts";
import { discordNotifications as notifications, discordNotificationResults as results, discordNotificationTargets as targets } from "../schema.ts";
import { cancelNotification, loadResultCancellationReason, type NotificationDb } from "./notifications.storage.ts";
import { normalizeNotificationJson } from "./notifications.hash.ts";
import { assertEnum } from "../rows.ts";

export const receiveResultNotification = async (
  tx: NotificationDb, rawJson: string, now: Date
): Promise<DiscordNotificationReceipt> => {
  let value: unknown;
  try { value = JSON.parse(rawJson); } catch { throw new NotificationInputError("invalid_input"); }
  const identity = readNotificationIdentity(value);
  const normalized = await normalizeNotificationJson(tx, rawJson);
  if (normalized.bytes > RESULT_NOTIFICATION_MAX_JSONB_BYTES) { throw new NotificationInputError("payload_too_large"); }
  const [existing] = await tx.select({
    id: notifications.id, family: notifications.family, hash: notifications.payloadHash, status: notifications.status
  }).from(notifications).leftJoin(results, eq(results.notificationId, notifications.id))
    .where(or(eq(notifications.id, identity.notificationId),
      and(eq(results.kind, identity.kind), eq(results.sourceJobId, identity.sourceJobId)))).limit(1);
  if (existing) {
    if (existing.id !== identity.notificationId || existing.family !== "result" || existing.hash !== normalized.hash) {
      throw new NotificationInputError("identity_conflict");
    }
    return { notificationId: existing.id, disposition: "duplicate",
      status: assertEnum(["PENDING", "IN_FLIGHT", "DELIVERED", "FAILED", "CANCELLED"] as const, existing.status, "notification status") };
  }
  const payload = validateNewNotification(value);
  const occurredAt = parseTimestamp(payload.occurredAt);
  if (!occurredAt) { throw new NotificationInputError("invalid_input"); }
  await tx.insert(notifications).values({
    id: payload.notificationId, family: "result", kind: payload.kind, dedupeKey: payload.notificationId,
    payload: sql`${normalized.text}::jsonb`, payloadHash: normalized.hash,
    createdAt: now, updatedAt: now, nextAttemptAt: now
  });
  await tx.insert(results).values({
    notificationId: payload.notificationId, kind: payload.kind, sourceJobId: payload.sourceJobId,
    occurredAt, settingsGeneration: BigInt(payload.settingsGeneration)
  });
  const references = payload.kind === "ocr_completed"
    ? [{ notificationId: payload.notificationId, targetKind: "match_draft", targetId: payload.data.matchDraftId }]
    : payload.data.matches.map(match => ({ notificationId: payload.notificationId, targetKind: "match", targetId: match.matchId }));
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
