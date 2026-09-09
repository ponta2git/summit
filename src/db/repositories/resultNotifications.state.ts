import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { RESULT_NOTIFICATION_KINDS, discordNotifications as notifications, discordNotificationParts as parts,
  discordNotificationResults as results, discordNotificationSettings as settings } from "../schema.ts";
import { assertEnum } from "../rows.ts";
import type { ResultNotificationKind } from "../schema.ts";
import type { ResultDeliveryContext, ResultNotificationPart, ResultNotificationSetting, ResultNotificationState } from "../ports.resultNotifications.ts";
import { cancelNotification, loadResultCancellationReason, lockNotification, type NotificationDb } from "./notifications.storage.ts";

const deliveryContextSchema = z.object({ webOrigin: z.string(), channelId: z.string().min(1) }).strict();
export const readDeliveryContext = (value: unknown): ResultDeliveryContext | null => {
  if (value === null) { return null; }
  const parsed = deliveryContextSchema.safeParse(value);
  // A malformed stored context must fail delivery, never use current configuration.
  return parsed.success ? parsed.data : null;
};

export const loadResultParts = async (tx: NotificationDb, id: string): Promise<readonly ResultNotificationPart[]> => {
  const rows = await tx.select().from(parts).where(eq(parts.notificationId, id)).orderBy(parts.partNo);
  return rows.map(row => ({
    partNo: row.partNo, status: assertEnum(["PENDING", "IN_FLIGHT", "DELIVERED", "CANCELLED"] as const, row.status, "notification part status"),
    attemptCount: row.attemptCount, deliveredMessageId: row.deliveredMessageId
  }));
};

export const inspectResultNotification = async (tx: NotificationDb, id: string): Promise<ResultNotificationState | null> => {
  const [row] = await tx.select({ notification: notifications, sourceJobId: results.sourceJobId }).from(notifications)
    .innerJoin(results, eq(results.notificationId, notifications.id)).where(and(eq(notifications.id, id), eq(notifications.family, "result")));
  if (!row) { return null; }
  const n = row.notification;
  return {
    notificationId: n.id, sourceJobId: row.sourceJobId, kind: assertEnum(RESULT_NOTIFICATION_KINDS, n.kind, "result notification kind"),
    status: assertEnum(["PENDING", "IN_FLIGHT", "DELIVERED", "FAILED", "CANCELLED"] as const, n.status, "notification status"),
    attemptCount: n.attemptCount, maxAttempts: n.maxAttempts, retryCycle: n.retryCycle,
    nextAttemptAt: n.nextAttemptAt, claimExpiresAt: n.claimExpiresAt, cancelReason: n.cancelReason,
    lastError: n.lastError, purgedAt: n.purgedAt, partCount: n.partCount, rendererVersion: n.rendererVersion,
    parts: await loadResultParts(tx, id),
    retryable: n.status === "FAILED" && n.purgedAt === null && await loadResultCancellationReason(tx, id) === null
  };
};

export const retryResultNotification = async (tx: NotificationDb, id: string, now: Date): Promise<boolean> => {
  const n = await lockNotification(tx, id);
  if (!n || n.family !== "result" || n.status !== "FAILED" || n.purgedAt !== null) { return false; }
  const reason = await loadResultCancellationReason(tx, id);
  if (reason) { await cancelNotification(tx, id, reason, now); return false; }
  await tx.update(notifications).set({
    status: "PENDING", attemptCount: 0, retryCycle: n.retryCycle + 1, terminalAt: null,
    lastError: null, nextAttemptAt: now, updatedAt: now
  }).where(eq(notifications.id, id));
  return true;
};

export const getResultSetting = async (tx: NotificationDb, kind: ResultNotificationKind): Promise<ResultNotificationSetting> => {
  const [row] = await tx.select().from(settings).where(eq(settings.kind, kind));
  if (!row) { throw new Error("Missing notification setting"); }
  return { kind, enabled: row.enabled, generation: row.generation.toString() };
};

export const setResultSetting = async (
  tx: NotificationDb, kind: ResultNotificationKind, enabled: boolean, now: Date
): Promise<ResultNotificationSetting> => {
  const current = await getResultSetting(tx, kind);
  const generation = BigInt(current.generation) + (current.enabled === enabled ? 0n : 1n);
  await tx.update(settings).set({ enabled, generation, updatedAt: now }).where(eq(settings.kind, kind));
  if (!enabled) {
    const pending = await tx.select({ id: notifications.id }).from(notifications)
      .innerJoin(results, eq(results.notificationId, notifications.id))
      .where(and(eq(results.kind, kind), isNull(notifications.purgedAt), inArray(notifications.status, ["PENDING", "IN_FLIGHT", "FAILED"])))
      .orderBy(notifications.id);
    for (const row of pending) { await cancelNotification(tx, row.id, "setting_off", now); }
  }
  return { kind, enabled, generation: generation.toString() };
};
