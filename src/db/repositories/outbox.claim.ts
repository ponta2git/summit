import { inArray } from "drizzle-orm";
import type { DbLike } from "../rows.ts";
import { discordNotifications } from "../schema.ts";
import { findAttendanceNotificationRows } from "./outbox.storage.ts";
import { mapOutboxRow, parseOutboxPayload, type OutboxEntry } from "./outbox.types.ts";
import { notificationTransaction } from "./notifications.storage.ts";
import { claimNotifications, releaseExpiredNotificationClaims } from "./notifications.claim.ts";
import { failNotification } from "./notifications.delivery.ts";

/** Claim attendance notifications through the shared delivery contract. */
export const claimNextOutboxBatch = async (
  db: DbLike,
  options: { readonly limit: number; readonly now: Date; readonly claimDurationMs: number }
): Promise<readonly OutboxEntry[]> => notificationTransaction(db, "attendance", async (tx) => {
  const ids = await claimNotifications(tx, "attendance", options);
  if (ids.length === 0) {
    return [];
  }
  const rows = await findAttendanceNotificationRows(tx, inArray(discordNotifications.id, [...ids]));
  const claimed: OutboxEntry[] = [];
  for (const row of rows) {
    const payload = parseOutboxPayload(row.payload);
    if (payload) {
      claimed.push(mapOutboxRow(row, payload));
    } else {
      // A malformed persisted body must not roll back claims for unrelated Sessions.
      if (!row.claimToken || !await failNotification(tx, row.id, row.claimToken, "invalid_payload", null, options.now)) {
        throw new Error("Failed to isolate malformed attendance payload");
      }
    }
  }
  return claimed;
});

export const releaseExpiredOutboxClaims = (db: DbLike, now: Date): Promise<number> =>
  notificationTransaction(db, "attendance", tx => releaseExpiredNotificationClaims(tx, "attendance", now));
