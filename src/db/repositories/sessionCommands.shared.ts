import { and, eq, sql } from "drizzle-orm";

import { members, responses, sessions } from "../schema.ts";
import { enqueueOutbox } from "./outbox.ts";
import type {
  DbLike,
  ResponseChoice,
  ResponseRow,
  SessionRow
} from "../rows.ts";
import { mapResponse } from "./responses.ts";
import { mapSession } from "./sessions.internal.ts";
import type { EnqueueOutboxInput } from "./outbox.ts";
import type {
  PostponeTransitionOutcome,
  SaturdaySessionInput
} from "./sessionCommands.types.ts";
import { buildAskBodyIntent } from "./sessionOutboxIntents.ts";
import type { PostponeDecisionResult } from "../../domain/postponeDecision.ts";

export type DbTransaction =
  Parameters<Parameters<DbLike["transaction"]>[0]>[0];

export const lockSession = async (
  tx: DbTransaction,
  sessionId: string
): Promise<SessionRow | undefined> => {
  const rows = await tx
    .select()
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .for("update");
  return rows[0] ? mapSession(rows[0]) : undefined;
};

export const memberExists = async (
  tx: DbTransaction,
  memberId: string
): Promise<boolean> => {
  const rows = await tx
    .select({ id: members.id })
    .from(members)
    .where(eq(members.id, memberId))
    .limit(1);
  return rows.length > 0;
};

export const listLockedResponses = async (
  tx: DbTransaction,
  sessionId: string
): Promise<readonly ResponseRow[]> => {
  const rows = await tx
    .select()
    .from(responses)
    .where(eq(responses.sessionId, sessionId));
  return rows.map(mapResponse);
};

export const upsertInteractionResponse = async (
  tx: DbTransaction,
  input: {
    readonly id: string;
    readonly sessionId: string;
    readonly memberId: string;
    readonly choice: ResponseChoice;
    readonly answeredAt: Date;
    readonly sourceInteractionId: string;
  }
): Promise<
  | { readonly kind: "accepted"; readonly response: ResponseRow }
  | { readonly kind: "stale"; readonly response: ResponseRow }
> => {
  if (!/^\d{1,20}$/.test(input.sourceInteractionId)) {
    throw new Error("sourceInteractionId must be a numeric Discord snowflake");
  }

  const rows = await tx
    .insert(responses)
    .values({
      id: input.id,
      sessionId: input.sessionId,
      memberId: input.memberId,
      choice: input.choice,
      answeredAt: input.answeredAt,
      sourceInteractionId: input.sourceInteractionId
    })
    .onConflictDoUpdate({
      target: [responses.sessionId, responses.memberId],
      set: {
        choice: input.choice,
        answeredAt: input.answeredAt,
        sourceInteractionId: input.sourceInteractionId
      },
      setWhere: sql`${responses.sourceInteractionId} IS NULL
        OR ${responses.sourceInteractionId} < ${input.sourceInteractionId}`
    })
    .returning();

  if (rows[0]) {
    return { kind: "accepted", response: mapResponse(rows[0]) };
  }
  const existing = await tx
    .select()
    .from(responses)
    .where(
      and(
        eq(responses.sessionId, input.sessionId),
        eq(responses.memberId, input.memberId)
      )
    )
    .limit(1);
  if (!existing[0]) {
    throw new Error("stale response conflict had no persisted row");
  }
  return { kind: "stale", response: mapResponse(existing[0]) };
};

export const bumpSessionRevision = async (
  tx: DbTransaction,
  current: SessionRow,
  now: Date
): Promise<SessionRow> => {
  const rows = await tx
    .update(sessions)
    .set({
      revision: sql`${sessions.revision} + 1`,
      updatedAt: now
    })
    .where(eq(sessions.id, current.id))
    .returning();
  if (!rows[0]) {throw new Error("locked session disappeared while bumping revision");}
  return mapSession(rows[0]);
};

export const enqueueSessionIntents = async (
  tx: DbTransaction,
  entries: readonly EnqueueOutboxInput[]
): Promise<void> => {
  for (const entry of entries) {
    await enqueueOutbox(tx, entry);
  }
};

export const applyPostponeDecision = async (
  tx: DbTransaction,
  current: SessionRow,
  decision: Exclude<PostponeDecisionResult, { kind: "pending" }>,
  saturday: SaturdaySessionInput,
  now: Date
): Promise<PostponeTransitionOutcome> => {
  if (decision.kind === "cancelled") {
    const rows = await tx
      .update(sessions)
      .set({
        status: "COMPLETED",
        cancelReason: decision.reason,
        revision: sql`${sessions.revision} + 1`,
        updatedAt: now
      })
      .where(eq(sessions.id, current.id))
      .returning();
    if (!rows[0]) {throw new Error("locked postpone session disappeared");}
    return { outcome: "cancelled", session: mapSession(rows[0]) };
  }

  const inserted = await tx
    .insert(sessions)
    .values({
      id: saturday.id,
      weekKey: current.weekKey,
      postponeCount: 1,
      candidateDateIso: saturday.candidateDateIso,
      status: "ASKING",
      channelId: current.channelId,
      deadlineAt: saturday.deadlineAt
    })
    .onConflictDoNothing({
      target: [sessions.weekKey, sessions.postponeCount]
    })
    .returning();
  const existing = inserted[0]
    ? undefined
    : (
        await tx
          .select()
          .from(sessions)
          .where(
            and(
              eq(sessions.weekKey, current.weekKey),
              eq(sessions.postponeCount, 1)
            )
          )
          .limit(1)
      )[0];
  const saturdayRow = inserted[0] ?? existing;
  if (!saturdayRow) {throw new Error("Saturday session insert returned no row");}
  const saturdaySession = mapSession(saturdayRow);
  await enqueueSessionIntents(tx, [
    buildAskBodyIntent(saturdaySession)
  ]);

  const parentRows = await tx
    .update(sessions)
    .set({
      status: "POSTPONED",
      revision: sql`${sessions.revision} + 1`,
      updatedAt: now
    })
    .where(eq(sessions.id, current.id))
    .returning();
  if (!parentRows[0]) {throw new Error("locked postpone session disappeared");}
  return {
    outcome: "all_ok",
    session: mapSession(parentRows[0]),
    saturdaySession
  };
};
