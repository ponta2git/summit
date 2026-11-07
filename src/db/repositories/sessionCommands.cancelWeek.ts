import { eq, sql } from "drizzle-orm";
import type { DbLike } from "../rows.ts";
import { weeklyAskSchedules } from "../schema.ts";
import { runTransaction } from "../transaction.ts";
import { lockAttendanceCreation } from "./attendance.creation.ts";
import { enqueueOutboxInTransaction } from "./outbox.ts";
import type { CancelWeekInput, CancelWeekResult } from "./sessionCommands.types.ts";

/** Disable only an uncreated weekly automatic ask. Existing Sessions are never mutated. */
export const cancelWeekAtomically = (db: DbLike, input: CancelWeekInput): Promise<CancelWeekResult> =>
  runTransaction(db, async tx => {
    await lockAttendanceCreation(tx);
    const disabled = { disabledAt: input.now, disabledBy: input.invokerUserId, updatedAt: input.now };
    const [applied] = await tx.insert(weeklyAskSchedules)
      .values({ weekKey: input.weekKey, createdAt: input.now, ...disabled })
      .onConflictDoUpdate({
        target: weeklyAskSchedules.weekKey,
        set: disabled,
        setWhere: sql`${weeklyAskSchedules.autoSessionId} IS NULL AND ${weeklyAskSchedules.disabledAt} IS NULL`
      }).returning({ weekKey: weeklyAskSchedules.weekKey });
    if (!applied) {
      const [week] = await tx.select({ autoSessionId: weeklyAskSchedules.autoSessionId, disabledAt: weeklyAskSchedules.disabledAt })
        .from(weeklyAskSchedules).where(eq(weeklyAskSchedules.weekKey, input.weekKey));
      if (week?.autoSessionId) { return { kind: "already_started", weekKey: input.weekKey, noticeEnqueued: false }; }
      if (week?.disabledAt) { return { kind: "already_disabled", weekKey: input.weekKey, noticeEnqueued: false }; }
      throw new Error("Weekly ask schedule changed during disable");
    }
    const notice = await enqueueOutboxInTransaction(tx, {
      kind: "send_message", sessionId: null, weekKey: input.weekKey,
      dedupeKey: `weekly-ask-disabled-${input.weekKey}`, aggregateRevision: 1, ordinal: 0,
      payload: {
        kind: "send_message", channelId: input.channelId, renderer: "weekly_ask_disabled",
        extra: { invokerUserId: input.invokerUserId, suppressMentions: input.suppressMentions }
      }
    });
    return { kind: "applied", weekKey: input.weekKey, noticeEnqueued: !notice.skipped };
  });
