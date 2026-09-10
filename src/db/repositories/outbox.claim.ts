import { inArray } from "drizzle-orm";
import type { DbLike } from "../rows.ts";
import { discordNotifications } from "../schema.ts";
import { findAttendanceNotifications } from "./outbox.storage.ts";
import type { OutboxEntry } from "./outbox.types.ts";
import { notificationTransaction } from "./notifications.storage.ts";
import { claimNotifications, releaseExpiredNotificationClaims } from "./notifications.claim.ts";

/** Claim attendance notifications through the shared delivery contract. */
export const claimNextOutboxBatch = async (
  db: DbLike,
  options: { readonly limit: number; readonly now: Date; readonly claimDurationMs: number }
): Promise<readonly OutboxEntry[]> => notificationTransaction(db, "attendance", async (tx) => {
  const ids = await claimNotifications(tx, "attendance", options);
  if (ids.length === 0) {
    return [];
  }
  return findAttendanceNotifications(tx, inArray(discordNotifications.id, [...ids]));
});

export const releaseExpiredOutboxClaims = (db: DbLike, now: Date): Promise<number> =>
  notificationTransaction(db, "attendance", tx => releaseExpiredNotificationClaims(tx, "attendance", now));
