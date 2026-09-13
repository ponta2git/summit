import { and, eq, getTableColumns, isNotNull, type SQL } from "drizzle-orm";
import type { DbLike } from "../rows.ts";
import { discordNotifications, discordNotificationAttendance, discordNotificationParts } from "../schema.ts";
import type { AttendanceNotificationRow } from "./outbox.types.ts";

// why: application の attendance DTO へ、共有配送と業務関連を一度だけ組み立てる。
const attendanceNotificationColumns = {
  ...getTableColumns(discordNotifications),
  sessionId: discordNotificationAttendance.sessionId,
  aggregateRevision: discordNotificationAttendance.aggregateRevision,
  ordinal: discordNotificationAttendance.ordinal,
  deliveredMessageId: discordNotificationParts.deliveredMessageId
};

export const findAttendanceNotificationRows = async (
  db: Pick<DbLike, "select">,
  condition: SQL
): Promise<readonly AttendanceNotificationRow[]> => {
  const rows = await db.select(attendanceNotificationColumns)
    .from(discordNotifications)
    .innerJoin(discordNotificationAttendance, eq(discordNotificationAttendance.notificationId, discordNotifications.id))
    .innerJoin(discordNotificationParts, and(
      eq(discordNotificationParts.notificationId, discordNotifications.id),
      eq(discordNotificationParts.partNo, 0)
    ))
    .where(and(
      eq(discordNotifications.family, "attendance"),
      isNotNull(discordNotifications.payload),
      isNotNull(discordNotificationAttendance.sessionId),
      condition
    ));
  return rows.sort((left, right) => left.nextAttemptAt.getTime() - right.nextAttemptAt.getTime()
    || (left.sessionId ?? "").localeCompare(right.sessionId ?? "")
    || left.aggregateRevision - right.aggregateRevision || left.ordinal - right.ordinal);
};
