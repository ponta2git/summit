// source-of-truth: sessions repository の生成・message id 書き戻し。

import { randomUUID } from "node:crypto";

import { and, eq, isNull, sql } from "drizzle-orm";

import { discordOutbox, sessions } from "../schema.ts";
import type { DbLike, SessionRow } from "../rows.ts";
import { mapSession } from "./sessions.internal.ts";
import type { CreateAskSessionInput } from "./sessions.types.ts";

/**
 * Create an ASKING session for the given `(weekKey, postponeCount)`.
 *
 * @remarks
 * unique: `(weekKey, postponeCount)` unique + `onConflictDoNothing` で race を吸収。
 *   呼び出し側は `undefined` を skipped として扱い多重送信を回避する。
 */
export const createAskSession = async (
  db: DbLike,
  input: CreateAskSessionInput
): Promise<SessionRow | undefined> =>
  db.transaction(async (tx) => {
    const rows = await tx
      .insert(sessions)
      .values({
        id: input.id,
        weekKey: input.weekKey,
        postponeCount: input.postponeCount,
        candidateDateIso: input.candidateDateIso,
        status: "ASKING",
        channelId: input.channelId,
        deadlineAt: input.deadlineAt
      })
      .onConflictDoNothing({
        target: [sessions.weekKey, sessions.postponeCount]
      })
      .returning();
    const row = rows[0];
    if (!row) {return undefined;}
    for (const entry of input.outbox ?? []) {
      await tx
        .insert(discordOutbox)
        .values({
          id: randomUUID(),
          kind: entry.kind,
          sessionId: entry.sessionId,
          payload: entry.payload,
          dedupeKey: entry.dedupeKey,
          aggregateRevision: entry.aggregateRevision,
          ordinal: entry.ordinal
        })
        .onConflictDoNothing({ target: discordOutbox.dedupeKey });
    }
    return mapSession(row);
  });

export const updateAskMessageId = async (
  db: DbLike,
  id: string,
  messageId: string
): Promise<void> => {
  await db
    .update(sessions)
    .set({ askMessageId: messageId, updatedAt: sql`now()` })
    .where(eq(sessions.id, id));
};

export const updatePostponeMessageId = async (
  db: DbLike,
  id: string,
  messageId: string
): Promise<void> => {
  await db
    .update(sessions)
    .set({ postponeMessageId: messageId, updatedAt: sql`now()` })
    .where(eq(sessions.id, id));
};

/**
 * Back-fill `ask_message_id` only if currently NULL (CAS-on-NULL).
 *
 * @remarks
 * idempotent: outbox 配送成功後に呼ばれる。expired claim の競合配送や recovery が別 id を
 *   セット済みなら上書きせず、canonical message の drift を防ぐ。CAS 勝で `true`。
 */
export const backfillAskMessageId = async (
  db: DbLike,
  id: string,
  messageId: string
): Promise<boolean> => {
  const rows = await db
    .update(sessions)
    .set({ askMessageId: messageId, updatedAt: sql`now()` })
    .where(and(eq(sessions.id, id), isNull(sessions.askMessageId)))
    .returning({ id: sessions.id });
  return rows.length > 0;
};

/**
 * Back-fill `postpone_message_id` only if currently NULL (CAS-on-NULL).
 *
 * @remarks
 * See {@link backfillAskMessageId}.
 */
export const backfillPostponeMessageId = async (
  db: DbLike,
  id: string,
  messageId: string
): Promise<boolean> => {
  const rows = await db
    .update(sessions)
    .set({ postponeMessageId: messageId, updatedAt: sql`now()` })
    .where(and(eq(sessions.id, id), isNull(sessions.postponeMessageId)))
    .returning({ id: sessions.id });
  return rows.length > 0;
};
