import { and, eq, sql } from "drizzle-orm";

import { members, responses, sessions } from "../schema.ts";
import { enqueueOutboxInTransaction } from "./outbox.ts";
import type {
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
import type { DbTransaction } from "../transaction.ts";
export type { DbTransaction } from "../transaction.ts";
import { identityLayout, nativeId, wireId } from "../identities.ts";
import { responseColumns, sessionColumns } from "../identityColumns.ts";
import { insertIdentity } from "../identityInsert.ts";

export const lockSession = async (
  tx: DbTransaction,
  sessionId: string
): Promise<SessionRow | undefined> => {
  const rows = await tx
    .select(sessionColumns(await identityLayout(tx)))
    .from(sessions)
    .where(eq(wireId(await identityLayout(tx), sessions), sessionId))
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
    .where(eq(wireId(await identityLayout(tx), members), memberId))
    .limit(1);
  return rows.length > 0;
};

export const listLockedResponses = async (
  tx: DbTransaction,
  sessionId: string
): Promise<readonly ResponseRow[]> => {
  const rows = await tx
    .select(responseColumns(await identityLayout(tx)))
    .from(responses)
    .where(eq(responses.sessionId, nativeId(await identityLayout(tx), sessions, sessionId)));
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

  const layout = await identityLayout(tx);
  const accepted = await insertIdentity(tx, layout, responses, {
      id: input.id,
      sessionId: nativeId(layout, sessions, input.sessionId),
      memberId: nativeId(layout, members, input.memberId),
      choice: input.choice,
      answeredAt: input.answeredAt,
      sourceInteractionId: input.sourceInteractionId
    }, sql`ON CONFLICT (session_id, member_id) DO UPDATE SET
      choice = EXCLUDED.choice, answered_at = EXCLUDED.answered_at,
      source_interaction_id = EXCLUDED.source_interaction_id
      WHERE ${responses.sourceInteractionId} IS NULL
        OR ${responses.sourceInteractionId} < EXCLUDED.source_interaction_id`);
  const existing = await tx
    .select(responseColumns(layout))
    .from(responses)
    .where(
      and(
        eq(responses.sessionId, nativeId(layout, sessions, input.sessionId)),
        eq(responses.memberId, nativeId(layout, members, input.memberId))
      )
    )
    .limit(1);
  if (!existing[0]) {
    throw new Error("response upsert had no persisted row");
  }
  return { kind: accepted ? "accepted" : "stale", response: mapResponse(existing[0]) };
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
    .where(eq(wireId(await identityLayout(tx), sessions), current.id))
    .returning(sessionColumns(await identityLayout(tx)));
  if (!rows[0]) {throw new Error("locked session disappeared while bumping revision");}
  return mapSession(rows[0]);
};

export const enqueueSessionIntents = async (
  tx: DbTransaction,
  entries: readonly EnqueueOutboxInput[]
): Promise<void> => {
  for (const entry of entries) {
    await enqueueOutboxInTransaction(tx, entry);
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
      .where(eq(wireId(await identityLayout(tx), sessions), current.id))
      .returning(sessionColumns(await identityLayout(tx)));
    if (!rows[0]) {throw new Error("locked postpone session disappeared");}
    return { outcome: "cancelled", session: mapSession(rows[0]) };
  }

  const layout = await identityLayout(tx);
  await insertIdentity(tx, layout, sessions, {
      id: saturday.id,
      weekKey: current.weekKey,
      postponeCount: 1,
      candidateDateIso: saturday.candidateDateIso,
      status: "ASKING",
      channelId: current.channelId,
      deadlineAt: saturday.deadlineAt
    }, sql`ON CONFLICT (week_key, postpone_count) DO NOTHING`);
  const [saturdayRow] = await tx
          .select(sessionColumns(layout))
          .from(sessions)
          .where(
            and(
              eq(sessions.weekKey, current.weekKey),
              eq(sessions.postponeCount, 1)
            )
          )
          .limit(1);
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
    .where(eq(wireId(layout, sessions), current.id))
    .returning(sessionColumns(layout));
  if (!parentRows[0]) {throw new Error("locked postpone session disappeared");}
  return {
    outcome: "all_ok",
    session: mapSession(parentRows[0]),
    saturdaySession
  };
};
