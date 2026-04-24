// source-of-truth: HeldEvent (実開催履歴) 集約ルート。
//   DECIDED→COMPLETED CAS と HeldEvent 挿入を **単一 tx** で行う。COMPLETED は終端で起動時リカバリが
//   拾わないため、別 tx にすると「COMPLETED なのに HeldEvent 無し」の永続不整合が残る。
// @see requirements/base.md §8.3, §8.4, ADR-0031

import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import {
  SESSION_STATUSES,
  heldEventParticipants,
  heldEvents,
  sessions
} from "../schema.js";
import type {
  DbLike,
  HeldEventParticipantRow,
  HeldEventRow,
  SessionRow,
  SessionStatus
} from "../rows.js";

const assertStatus = (value: string): SessionStatus => {
  if ((SESSION_STATUSES as readonly string[]).includes(value)) {
    return value as SessionStatus;
  }
  throw new Error(`Invalid session status: ${value}`);
};

const mapSession = (row: typeof sessions.$inferSelect): SessionRow => ({
  id: row.id,
  weekKey: row.weekKey,
  postponeCount: row.postponeCount,
  candidateDateIso: row.candidateDateIso,
  status: assertStatus(row.status),
  channelId: row.channelId,
  askMessageId: row.askMessageId,
  postponeMessageId: row.postponeMessageId,
  deadlineAt: row.deadlineAt,
  decidedStartAt: row.decidedStartAt,
  cancelReason: row.cancelReason,
  reminderAt: row.reminderAt,
  reminderSentAt: row.reminderSentAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt
});

export interface CompleteDecidedSessionAsHeldInput {
  readonly sessionId: string;
  readonly reminderSentAt: Date;
  readonly memberIds: readonly string[];
}

export interface CompleteDecidedSessionAsHeldResult {
  readonly session: SessionRow;
  readonly heldEvent: HeldEventRow;
  readonly participants: readonly HeldEventParticipantRow[];
}

/**
 * Atomically transition DECIDED→COMPLETED and record the HeldEvent + participants.
 *
 * @remarks
 * tx: session CAS と held_events / held_event_participants 挿入を 1 tx に束ねる。CAS 敗北時は
 *   rollback されるため held_events を書かない。
 * invariant: `heldDateIso` / `startAt` は RETURNING で取得した session 行から**リポジトリ内で**導出する。
 *   呼び出し側の入力を信用すると session と不整合な HeldEvent を作り得る。
 * idempotent: `held_events.session_id` unique + `onConflictDoNothing` で二重挿入防止。
 *   participants も複合 PK 衝突で no-op。
 * @see ADR-0031
 */
export const completeDecidedSessionAsHeld = async (
  db: DbLike,
  input: CompleteDecidedSessionAsHeldInput
): Promise<CompleteDecidedSessionAsHeldResult | undefined> => {
  return db.transaction(async (tx) => {
    // race: CAS primitive。WHERE status = 'DECIDED' 一致のみ遷移成功。
    const updated = await tx
      .update(sessions)
      .set({
        status: "COMPLETED",
        reminderSentAt: input.reminderSentAt,
        updatedAt: sql`now()` as unknown as Date
      })
      .where(
        and(eq(sessions.id, input.sessionId), eq(sessions.status, "DECIDED"))
      )
      .returning();
    const sessionRow = updated[0];
    if (!sessionRow) {
      return undefined;
    }

    if (!sessionRow.decidedStartAt) {
      // invariant: DECIDED 行は decidedStartAt を必ず持つ (decide.ts 側で保証)。欠損は schema drift。
      throw new Error(
        `completeDecidedSessionAsHeld: session ${sessionRow.id} has no decidedStartAt despite DECIDED status`
      );
    }

    const heldEventId = randomUUID();
    const insertedHeldEvent = await tx
      .insert(heldEvents)
      .values({
        id: heldEventId,
        sessionId: input.sessionId,
        heldDateIso: sessionRow.candidateDateIso,
        startAt: sessionRow.decidedStartAt
      })
      // idempotent: session_id unique 衝突時は既存を尊重。保険的な冪等性。
      .onConflictDoNothing({ target: heldEvents.sessionId })
      .returning();

    const heldEventRow =
      insertedHeldEvent[0] ??
      (await tx
        .select()
        .from(heldEvents)
        .where(eq(heldEvents.sessionId, input.sessionId))
        .limit(1))[0];

    if (!heldEventRow) {
      // invariant: tx 内で insert も select も空は自己矛盾。
      throw new Error("completeDecidedSessionAsHeld: heldEventRow missing");
    }

    const participants: HeldEventParticipantRow[] = [];
    if (input.memberIds.length > 0) {
      const rows = await tx
        .insert(heldEventParticipants)
        .values(
          input.memberIds.map((memberId) => ({
            heldEventId: heldEventRow.id,
            memberId
          }))
        )
        .onConflictDoNothing({
          target: [
            heldEventParticipants.heldEventId,
            heldEventParticipants.memberId
          ]
        })
        .returning();
      participants.push(...rows);
    }

    return {
      session: mapSession(sessionRow),
      heldEvent: heldEventRow,
      participants
    };
  });
};

export const findHeldEventBySessionId = async (
  db: DbLike,
  sessionId: string
): Promise<HeldEventRow | undefined> => {
  const rows = await db
    .select()
    .from(heldEvents)
    .where(eq(heldEvents.sessionId, sessionId))
    .limit(1);
  return rows[0];
};

export const listHeldEventParticipants = async (
  db: DbLike,
  heldEventId: string
): Promise<HeldEventParticipantRow[]> => {
  const rows = await db
    .select()
    .from(heldEventParticipants)
    .where(eq(heldEventParticipants.heldEventId, heldEventId));
  return rows;
};
