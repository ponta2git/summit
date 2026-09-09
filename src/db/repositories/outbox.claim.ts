import { inArray, sql } from "drizzle-orm";
import type { DbLike } from "../rows.ts";
import { discordNotifications } from "../schema.ts";
import { findAttendanceNotifications } from "./outbox.storage.ts";
import type { OutboxEntry } from "./outbox.types.ts";

/** Claim attendance notifications through the shared delivery contract. */
export const claimNextOutboxBatch = async (
  db: DbLike,
  options: { readonly limit: number; readonly now: Date; readonly claimDurationMs: number }
): Promise<readonly OutboxEntry[]> => db.transaction(async (tx) => {
  const ids = await tx.execute<{ id: string }>(sql`
    SELECT id FROM public.claim_discord_notifications(
      'attendance', ${options.limit}, ${options.now.toISOString()}, ${options.claimDurationMs}
    )
  `);
  if (ids.length === 0) {
    return [];
  }
  return findAttendanceNotifications(tx, inArray(discordNotifications.id, ids.map(row => row.id)));
});

export const releaseExpiredOutboxClaims = async (db: DbLike, now: Date): Promise<number> => {
  const [row] = await db.execute<{ count: number }>(sql`
    SELECT public.release_discord_notification_claims('attendance', ${now.toISOString()}) AS count
  `);
  return row?.count ?? 0;
};
