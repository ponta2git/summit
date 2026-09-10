import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { RESULT_NOTIFICATION_KINDS, discordNotifications as notifications, discordNotificationParts as parts,
  discordNotificationResults as results, discordNotificationSettings as settings } from "../schema.ts";
import { assertEnum } from "../rows.ts";
import type { ResultNotificationKind } from "../schema.ts";
import type { ClaimedResultNotification, ResultDeliveryContext, ResultNotificationPart, ResultNotificationSetting, ResultNotificationState } from "../ports.resultNotifications.ts";
import { cancelNotification, loadResultCancellationReason, lockNotification, notificationStateColumns, type NotificationDb } from "./notifications.storage.ts";

const deliveryContextSchema = z.object({ webOrigin: z.string(), channelId: z.string().min(1) }).strict();
export const readDeliveryContext = (value: unknown): ResultDeliveryContext | null => {
  if (value === null) { return null; }
  const parsed = deliveryContextSchema.safeParse(value);
  // A malformed stored context must fail delivery, never use current configuration.
  return parsed.success ? parsed.data : null;
};

const loadResultParts = async (
  tx: NotificationDb, ids: readonly string[]
): Promise<ReadonlyMap<string, readonly ResultNotificationPart[]>> => {
  const rows = await tx.select({
    notificationId: parts.notificationId, partNo: parts.partNo, status: parts.status,
    attemptCount: parts.attemptCount, deliveredMessageId: parts.deliveredMessageId
  }).from(parts).where(inArray(parts.notificationId, [...ids])).orderBy(parts.partNo);
  const grouped = new Map<string, ResultNotificationPart[]>();
  for (const row of rows) {
    const group = grouped.get(row.notificationId) ?? [];
    group.push({
      partNo: row.partNo, status: assertEnum(["PENDING", "IN_FLIGHT", "DELIVERED", "CANCELLED"] as const, row.status, "notification part status"),
      attemptCount: row.attemptCount, deliveredMessageId: row.deliveredMessageId
    });
    grouped.set(row.notificationId, group);
  }
  return grouped;
};

/** Hydrate a claimed batch once, inside the command that owns its parent locks. */
export const findClaimedResultNotifications = async (
  tx: NotificationDb, ids: readonly string[]
): Promise<readonly ClaimedResultNotification[]> => {
  if (ids.length === 0) { return []; }
  const rows = await tx.select({
    id: notifications.id, kind: notifications.kind, payload: notifications.payload,
    claimToken: notifications.claimToken, attemptCount: notifications.attemptCount, maxAttempts: notifications.maxAttempts,
    partCount: notifications.partCount, rendererVersion: notifications.rendererVersion, deliveryContext: notifications.deliveryContext
  }).from(notifications).where(inArray(notifications.id, [...ids])).orderBy(notifications.nextAttemptAt, notifications.id);
  const grouped = await loadResultParts(tx, ids);
  return rows.map(row => {
    if (!row.claimToken) { throw new Error("Missing notification claim token"); }
    return {
      ...row, claimToken: row.claimToken, kind: assertEnum(RESULT_NOTIFICATION_KINDS, row.kind, "result notification kind"),
      deliveryContext: readDeliveryContext(row.deliveryContext), parts: grouped.get(row.id) ?? []
    };
  });
};

export const inspectResultNotification = async (tx: NotificationDb, id: string): Promise<ResultNotificationState | null> => {
  const [row] = await tx.select({ notification: {
    ...notificationStateColumns, kind: notifications.kind,
    nextAttemptAt: notifications.nextAttemptAt, cancelReason: notifications.cancelReason
  }, sourceJobId: results.sourceJobId }).from(notifications)
    .innerJoin(results, eq(results.notificationId, notifications.id)).where(and(eq(notifications.id, id), eq(notifications.family, "result")));
  if (!row) { return null; }
  const n = row.notification;
  return {
    notificationId: n.id, sourceJobId: row.sourceJobId, kind: assertEnum(RESULT_NOTIFICATION_KINDS, n.kind, "result notification kind"),
    status: assertEnum(["PENDING", "IN_FLIGHT", "DELIVERED", "FAILED", "CANCELLED"] as const, n.status, "notification status"),
    attemptCount: n.attemptCount, maxAttempts: n.maxAttempts, retryCycle: n.retryCycle,
    nextAttemptAt: n.nextAttemptAt, claimExpiresAt: n.claimExpiresAt, cancelReason: n.cancelReason,
    lastError: n.lastError, purgedAt: n.purgedAt, partCount: n.partCount, rendererVersion: n.rendererVersion,
    parts: (await loadResultParts(tx, [id])).get(id) ?? [],
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
