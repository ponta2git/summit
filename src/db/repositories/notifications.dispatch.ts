import { and, eq, isNotNull, isNull, ne, notInArray, sql } from "drizzle-orm";
import { discordNotifications as notifications } from "../schema.ts";
import { parseDbTimestamp } from "../rows.ts";
import type { NotificationDb, NotificationFamily } from "./notifications.storage.ts";

/** Discover pending work and abandoned claims without scanning retained history. */
export const findNextNotificationDispatchAt = async (
  db: Pick<NotificationDb, "execute">, family: NotificationFamily, excludeIds: readonly string[] = []
): Promise<Date | null> => {
  const retained = and(eq(notifications.family, family), isNull(notifications.purgedAt),
    excludeIds.length ? notInArray(notifications.id, [...excludeIds]) : undefined);
  // why: 別々の min にして、次回時刻と claim 期限それぞれの index を利用する。
  const [row] = await db.execute<{ pending: unknown; expires: unknown }>(sql`SELECT
    (SELECT min(${notifications.nextAttemptAt}) FROM ${notifications}
      WHERE ${and(retained, eq(notifications.status, "PENDING"))}) AS pending,
    (SELECT min(${notifications.claimExpiresAt}) FROM ${notifications}
      WHERE ${and(retained, isNotNull(notifications.claimToken), ne(notifications.status, "PENDING"))}) AS expires
  `);
  const pending = parseDbTimestamp(row?.pending, "next pending notification");
  const expires = parseDbTimestamp(row?.expires, "next notification claim expiry");
  return pending && expires ? (pending < expires ? pending : expires) : pending ?? expires;
};
