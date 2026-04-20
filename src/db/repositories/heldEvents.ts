// source-of-truth: HeldEvent (実開催履歴) 集約ルート。
//   §8.3 の HeldEvent 永続化。中止回 (CANCELLED/SKIPPED) では作成しないため、
//   DECIDED→COMPLETED CAS と挿入を **単一トランザクション** で行う。
//   COMPLETED は終端状態で起動時リカバリ (findNonTerminalSessions) が拾わないため、
//   別 tx に分けると「COMPLETED なのに HeldEvent 無し」の永続不整合が残り得る。
// @see requirements/base.md §8.3, §8.4
// @see docs/adr/0031-held-event-persistence.md

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
 * @returns The updated session, held event, and participant rows; or `undefined` if the
 *   CAS lost (session is not DECIDED anymore — another handler already transitioned it).
 *
 * @remarks
 * tx: session status CAS と held_events / held_event_participants の挿入を 1 トランザクションに
 *   まとめる。CAS 敗北時は held_events を書かない（`RETURNING` 無しならロールバック）。
 * invariant: heldDateIso / startAt は CAS の RETURNING で取れた session 行（candidateDateIso /
 *   decidedStartAt）から**リポジトリ内で**導出する。呼び出し側から入力を受け取って信用すると、
 *   将来 session 本体と不整合な HeldEvent を作り得る。
 * idempotent: `held_events.session_id` unique + `onConflictDoNothing` で二重挿入を防ぐ。
 *   participants 側も複合 PK で衝突時 no-op。起動時リカバリ経路ではそもそも COMPLETED は
 *   拾われないが、保険として冪等を維持する。
 * @see docs/adr/0031-held-event-persistence.md
 */
export const completeDecidedSessionAsHeld = async (
  db: DbLike,
  input: CompleteDecidedSessionAsHeldInput
): Promise<CompleteDecidedSessionAsHeldResult | undefined> => {
  return db.transaction(async (tx) => {
    // race: CAS primitive。WHERE status = 'DECIDED' の条件一致のみ遷移成功。
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
      // invariant: DECIDED 状態の行は decidedStartAt を必ず持つ (decide.ts 側で保証)。
      //   取り損なうのは schema drift。tx を abort して呼び出し側に伝える。
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
      // idempotent: session_id unique 衝突時は既存を尊重。この経路は CAS 勝者のみ通るため
      //   通常は衝突しないが、仮に重複挿入経路が追加されても本保険で守る。
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
      // defensive: 挿入も取得もできない状況は理論上起きない (tx 内で自己矛盾)。
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
