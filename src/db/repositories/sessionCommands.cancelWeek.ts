import { runTransaction } from "../transaction.ts";
import {
  asc,
  eq,
  inArray,
  sql
} from "drizzle-orm";

import {
  discordNotifications,
  discordNotificationAttendance,
  heldEvents,
  sessions
} from "../schema.ts";
import type { DbLike, SessionRow, SessionStatus } from "../rows.ts";
import { mapSession } from "./sessions.internal.ts";
import { enqueueOutboxInTransaction } from "./outbox.ts";
import { cancelNotification, lockNotificationFamily } from "./notifications.storage.ts";
import type {
  CancelWeekInput,
  CancelWeekResult
} from "./sessionCommands.types.ts";
import { identityLayout, wireId } from "../identities.ts";
import { sessionColumns } from "../identityColumns.ts";
import { insertIdentity } from "../identityInsert.ts";

const CANCELLABLE_WEEK_STATUSES = [
  "ASKING",
  "POSTPONE_VOTING",
  "POSTPONED",
  "DECIDED",
  "CANCELLED"
] as const satisfies readonly SessionStatus[];

/**
 * Skip one ISO week and persist its channel notice in the same transaction.
 *
 * @remarks
 * Lock order is postpone_count then id. With no Session, a weekKey/postponeCount=0
 * SKIPPED sentinel suppresses later cron creation. A recorded HeldEvent wins.
 */
export const cancelWeekAtomically = async (
  db: DbLike,
  input: CancelWeekInput
): Promise<CancelWeekResult> =>
  runTransaction(db, async (tx) => {
    const layout = await identityLayout(tx);
    const lockedRows = await tx
      .select(sessionColumns(layout))
      .from(sessions)
      .where(eq(sessions.weekKey, input.weekKey))
      .orderBy(asc(sessions.postponeCount), asc(wireId(layout, sessions)))
      .for("update");
    let lockedSessions = lockedRows.map(mapSession);
    let sentinelCreated = false;
    let skippedSessions: SessionRow[] = [];

    if (lockedSessions.length === 0) {
      const inserted = await insertIdentity(tx, layout, sessions, {
          id: input.sentinelSessionId,
          weekKey: input.weekKey,
          postponeCount: 0,
          candidateDateIso: input.candidateDateIso,
          status: "SKIPPED",
          channelId: input.channelId,
          deadlineAt: input.deadlineAt,
          cancelReason: "manual_skip",
          revision: 1,
          createdAt: input.now,
          updatedAt: input.now
        }, sql`ON CONFLICT (week_key, postpone_count) DO NOTHING`);
      if (inserted) {
        const [row] = await tx.select(sessionColumns(layout)).from(sessions)
          .where(eq(wireId(layout, sessions), input.sentinelSessionId));
        if (!row) { throw new Error("Inserted cancellation sentinel could not be reloaded"); }
        const sentinel = mapSession(row);
        lockedSessions = [sentinel];
        skippedSessions = [sentinel];
        sentinelCreated = true;
      } else {
        // race: initial Session creation won after the empty SELECT. Re-lock the winner
        // and continue the same cancellation transaction instead of surfacing unique failure.
        const racedRows = await tx
          .select(sessionColumns(layout))
          .from(sessions)
          .where(eq(sessions.weekKey, input.weekKey))
          .orderBy(asc(sessions.postponeCount), asc(wireId(layout, sessions)))
          .for("update");
        lockedSessions = racedRows.map(mapSession);
        if (lockedSessions.length === 0) {
          throw new Error("cancel_week conflict winner could not be reloaded");
        }
      }
    }

    if (!sentinelCreated) {
      // race: 最初のSELECTが金曜lockを待つ間に、順延txが土曜を作成してcommitし得る。
      // 金曜を保持した後の新snapshotで週全体を再読込し、同時作成された土曜も取消対象にする。
      const currentRows = await tx
        .select(sessionColumns(layout))
        .from(sessions)
        .where(eq(sessions.weekKey, input.weekKey))
        .orderBy(asc(sessions.postponeCount), asc(wireId(layout, sessions)))
        .for("update");
      lockedSessions = currentRows.map(mapSession);
      const held = await tx
        .select({ sessionId: wireId(layout, sessions) })
        .from(heldEvents)
        .innerJoin(sessions, eq(heldEvents.sessionId, sessions.id))
        .where(eq(sessions.weekKey, input.weekKey))
        .limit(1);
      const heldSession = lockedSessions.find(
        (session) => session.id === held[0]?.sessionId
      );
      if (heldSession) {
        return {
          kind: "already_held",
          weekKey: input.weekKey,
          session: heldSession
        };
      }
    }

    if (!sentinelCreated) {
      const cancellableIds = lockedSessions
        .filter((session) =>
          CANCELLABLE_WEEK_STATUSES.some((status) => status === session.status)
        )
        .map((session) => session.id);
      if (cancellableIds.length > 0) {
        const updated = await tx
          .update(sessions)
          .set({
            status: "SKIPPED",
            cancelReason: "manual_skip",
            revision: sql`${sessions.revision} + 1`,
            updatedAt: input.now
          })
          .where(inArray(wireId(layout, sessions), cancellableIds))
          .returning(sessionColumns(layout));
        skippedSessions = updated
          .map(mapSession)
          .sort(
            (left, right) =>
              left.postponeCount - right.postponeCount ||
              left.id.localeCompare(right.id)
          );
      }
    }

    const alreadySkipped = lockedSessions.filter(
      (session) => session.status === "SKIPPED"
    );
    const noticeAnchor = skippedSessions[0] ?? alreadySkipped[0];
    if (!noticeAnchor) {
      return {
        kind: "already_closed",
        weekKey: input.weekKey,
        sessions: lockedSessions
      };
    }

    const dedupeKey = "cancel-week-notice-" + input.weekKey;
    const skippedIds = [
      ...new Set([
        ...skippedSessions.map((session) => session.id),
        ...alreadySkipped.map((session) => session.id)
      ])
    ];
    await lockNotificationFamily(tx, "attendance");
    const conflicting = await tx
      .select({ id: discordNotifications.id })
      .from(discordNotifications)
      .innerJoin(discordNotificationAttendance, eq(discordNotificationAttendance.notificationId, discordNotifications.id))
      .where(sql`${inArray(discordNotificationAttendance.sessionId, skippedIds)}
        AND ${discordNotifications.status} IN ('PENDING','IN_FLIGHT','FAILED')
        AND ${discordNotifications.dedupeKey} <> ${dedupeKey}`)
      .orderBy(discordNotifications.id);
    for (const row of conflicting) {
      await cancelNotification(tx, row.id, "manual_skip", input.now);
    }

    const notice = await enqueueOutboxInTransaction(tx, {
        kind: "send_message",
        sessionId: noticeAnchor.id,
        dedupeKey,
        aggregateRevision: noticeAnchor.revision,
        ordinal: 0,
        payload: {
          kind: "send_message",
          channelId: input.channelId,
          renderer: "cancel_week_notice",
          extra: {
            invokerUserId: input.invokerUserId,
            suppressMentions: input.suppressMentions
          }
        }
    });

    return {
      kind:
        skippedSessions.length > 0 || sentinelCreated
          ? "applied"
          : "already_skipped",
      weekKey: input.weekKey,
      skippedSessions,
      sentinelCreated,
      noticeEnqueued: !notice.skipped
    };
  });
