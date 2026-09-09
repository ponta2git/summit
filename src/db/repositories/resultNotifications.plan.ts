import { eq } from "drizzle-orm";
import { discordNotifications as notifications, discordNotificationParts as parts } from "../schema.ts";
import type { ResultDeliveryContext } from "../ports.resultNotifications.ts";
import { ownsNotificationClaim } from "../../domain/notification.ts";
import { buildNotificationLinks } from "../../features/result-notifications/links.ts";
import { lockNotification, type NotificationDb } from "./notifications.storage.ts";
import { readDeliveryContext } from "./resultNotifications.state.ts";

export const planResultNotification = async (
  tx: NotificationDb, id: string, token: string,
  options: { readonly count: number; readonly rendererVersion: number; readonly context: ResultDeliveryContext; readonly now: Date }
): Promise<boolean> => {
  const n = await lockNotification(tx, id);
  if (!n || n.family !== "result" || !ownsNotificationClaim(n, token, options.now)) { return false; }
  if (!Number.isInteger(options.count) || options.count < 1 || options.count > 10_000
    || !Number.isInteger(options.rendererVersion) || options.rendererVersion < 1 || !options.context.channelId) {
    throw new Error("Invalid notification part plan");
  }
  buildNotificationLinks(options.context.webOrigin);
  if (n.partCount > 0) {
    const existing = readDeliveryContext(n.deliveryContext);
    if (n.partCount !== options.count || n.rendererVersion !== options.rendererVersion
      || existing?.webOrigin !== options.context.webOrigin || existing.channelId !== options.context.channelId) {
      throw new Error("Notification part plan conflict");
    }
    return true;
  }
  await tx.update(notifications).set({
    partCount: options.count, rendererVersion: options.rendererVersion, deliveryContext: options.context, updatedAt: options.now
  }).where(eq(notifications.id, id));
  for (let offset = 0; offset < options.count; offset += 1_000) {
    await tx.insert(parts).values(Array.from({ length: Math.min(1_000, options.count - offset) }, (_, index) => ({
      notificationId: id, partNo: offset + index
    })));
  }
  return true;
};
