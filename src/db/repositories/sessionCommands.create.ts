import { eq, inArray, sql } from "drizzle-orm";
import { ACTIVE_SESSION_STATUSES, type CreationRejection } from "../../domain/sessionCreation.ts";
import { deadlineFor, formatCandidateDateIso, isoWeekKey, isWeeklyAskWindow } from "../../time/index.ts";
import { identityLayout, nativeId, wireId } from "../identities.ts";
import { sessionColumns } from "../identityColumns.ts";
import { insertIdentity } from "../identityInsert.ts";
import type { DbLike, SessionRow } from "../rows.ts";
import { sessions, weeklyAskSchedules } from "../schema.ts";
import { runTransaction } from "../transaction.ts";
import { lockAttendanceCreation } from "./attendance.creation.ts";
import { enqueueOutboxInTransaction } from "./outbox.ts";
import { buildAskBodyIntent } from "./sessionOutboxIntents.ts";
import { mapSession } from "./sessions.internal.ts";

export interface CreateSessionInput {
  readonly id: string;
  readonly source: "manual" | "weekly_auto";
  readonly requestId?: string;
  readonly channelId: string;
  readonly now: Date;
}

export type CreateSessionResult =
  | { readonly kind: "created"; readonly session: SessionRow }
  | { readonly kind: "duplicate"; readonly session: SessionRow }
  | { readonly kind: "rejected"; readonly reason: CreationRejection; readonly session?: SessionRow };

/** Admission, weekly identity, Session and first delivery intent commit together. */
export const createSession = (db: DbLike, input: CreateSessionInput): Promise<CreateSessionResult> =>
  runTransaction(db, async tx => {
    await lockAttendanceCreation(tx);
    const layout = await identityLayout(tx);
    const columns = sessionColumns(layout);
    if (input.requestId) {
      const [previous] = await tx.select(columns).from(sessions).where(eq(sessions.requestId, input.requestId));
      if (previous) { return { kind: "duplicate", session: mapSession(previous) }; }
    }
    const weekKey = isoWeekKey(input.now);
    const candidateDateIso = formatCandidateDateIso(input.now);
    const deadlineAt = deadlineFor(input.now);
    if (input.now >= deadlineAt) { return { kind: "rejected", reason: "deadline_passed" }; }
    if (input.source === "weekly_auto") {
      if (!isWeeklyAskWindow(input.now)) { return { kind: "rejected", reason: "outside_auto_window" }; }
      const [week] = await tx.select({ disabledAt: weeklyAskSchedules.disabledAt, autoSessionId: weeklyAskSchedules.autoSessionId })
        .from(weeklyAskSchedules).where(eq(weeklyAskSchedules.weekKey, weekKey));
      if (week?.disabledAt) { return { kind: "rejected", reason: "auto_disabled" }; }
      if (week?.autoSessionId) { return { kind: "rejected", reason: "auto_started" }; }
    }
    const [sameDate] = await tx.select(columns).from(sessions)
      .where(sql`${sessions.candidateDateIso} = ${candidateDateIso} AND ${sessions.occupiesDate}`);
    if (sameDate) { return { kind: "rejected", reason: "date_exists", session: mapSession(sameDate) }; }
    const [active] = await tx.select(columns).from(sessions).where(inArray(sessions.status, [...ACTIVE_SESSION_STATUSES])).limit(1);
    if (active) { return { kind: "rejected", reason: "active_session", session: mapSession(active) }; }
    await insertIdentity(tx, layout, sessions, {
      id: input.id, weekKey, candidateDateIso, deadlineAt, source: input.source,
      requestId: input.requestId ?? null, postponeCount: 0, status: "ASKING", channelId: input.channelId,
      createdAt: input.now, updatedAt: input.now
    }, sql``);
    const [row] = await tx.select(columns).from(sessions).where(eq(wireId(layout, sessions), input.id));
    if (!row) { throw new Error("Created session could not be reloaded"); }
    const session = mapSession(row);
    if (input.source === "weekly_auto") {
      const autoSessionId = nativeId(layout, sessions, session.id);
      const [scheduled] = await tx.insert(weeklyAskSchedules)
        .values({ weekKey, autoSessionId, createdAt: input.now, updatedAt: input.now })
        .onConflictDoUpdate({
          target: weeklyAskSchedules.weekKey,
          set: { autoSessionId, updatedAt: input.now },
          setWhere: sql`${weeklyAskSchedules.disabledAt} IS NULL AND ${weeklyAskSchedules.autoSessionId} IS NULL`
        }).returning({ weekKey: weeklyAskSchedules.weekKey });
      // A writer outside the creation gate must not silently lose a weekly stop.
      if (!scheduled) { throw new Error("Weekly ask schedule changed during creation"); }
    }
    await enqueueOutboxInTransaction(tx, buildAskBodyIntent(session));
    return { kind: "created", session };
  });
