import { inArray } from "drizzle-orm";
import type { DbLike } from "../rows.ts";
import { discordNotifications } from "../schema.ts";
import { findAttendanceNotificationRows } from "./outbox.storage.ts";
import { mapOutboxRow, parseOutboxPayload, type OutboxEntry } from "./outbox.types.ts";
import { notificationTransaction } from "./notifications.storage.ts";
import { claimNotifications, releaseExpiredNotificationClaims } from "./notifications.claim.ts";
import { failNotification } from "./notifications.delivery.ts";
import { systemClock, type Clock } from "../../time/index.ts";
import { notificationCommandNow } from "../../time/lease.ts";
import { notificationNotStarted } from "../notificationControl.ts";

/** Claim attendance notifications through the shared delivery contract. */
export const claimNextOutboxBatch = async (
  db: DbLike,
  options: { readonly limit: number; readonly now: Date; readonly claimDurationMs: number },
  clock: Clock = systemClock
): Promise<readonly OutboxEntry[]> => notificationNotStarted(notificationTransaction(db, "attendance", async (tx) => {
  const claims = await claimNotifications(tx, "attendance", { ...options, now: notificationCommandNow(clock, options.now) }, clock);
  if (claims.length === 0) {
    return [];
  }
  const rows = await findAttendanceNotificationRows(tx, inArray(discordNotifications.id, claims.map(claim => claim.id)));
  const leases = new Map(claims.map(claim => [claim.id, claim.lease]));
  const claimed: OutboxEntry[] = [];
  for (const row of rows) {
    const payload = parseOutboxPayload(row.payload);
    if (payload) {
      const lease = leases.get(row.id);
      if (!lease) { throw new Error("Missing attendance claim observation"); }
      claimed.push({ ...mapOutboxRow(row, payload), lease });
    } else {
      // A malformed persisted body must not roll back claims for unrelated Sessions.
      if (!row.claimToken || !await failNotification(tx, row.id, row.claimToken, "invalid_payload", null, options.now)) {
        throw new Error("Failed to isolate malformed attendance payload");
      }
    }
  }
  return claimed;
}, { key: "claim", operation: "claim" }), []);

export const releaseExpiredOutboxClaims = (db: DbLike, now: Date): Promise<number> =>
  notificationNotStarted(notificationTransaction(db, "attendance", tx => releaseExpiredNotificationClaims(tx, "attendance", now),
    { key: "recovery:expired", operation: "maintenance" }), 0);
