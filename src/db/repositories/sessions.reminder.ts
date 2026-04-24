// source-of-truth: reminder 配送の claim-first プリミティブ。
// @see ADR-0024, ADR-0038

import { and, eq, isNull, sql } from "drizzle-orm";

import { sessions } from "../schema.js";
import type { DbLike, SessionRow } from "../rows.js";
import { mapSession } from "./sessions.internal.js";

/**
 * Atomically claim the reminder dispatch slot for a DECIDED session.
 *
 * @returns The updated session on CAS win, or `undefined` if the session is no longer DECIDED
 *   or `reminder_sent_at` was already set by a concurrent caller (race lost).
 *
 * @remarks
 * race: claim-first プリミティブ。Discord 送信の**前に**実行することで、同時並行パス
 *   (cron tick と起動時 recovery の重複) が同じ reminder を二重送信するのを防ぐ。
 * idempotent: `reminder_sent_at IS NULL` を条件に含むため、2 度目以降の呼び出しは必ず
 *   undefined を返す (勝者は先着 1 件のみ)。
 * 失敗経路: Discord 送信が throw したら `revertReminderClaim` で `reminder_sent_at=NULL` に
 *   戻し、次 tick で再試行可能にする (at-least-once semantics)。
 * @see docs/adr/0024-reminder-dispatch.md
 */
export const claimReminderDispatch = async (
  db: DbLike,
  id: string,
  now: Date
): Promise<SessionRow | undefined> => {
  const rows = await db
    .update(sessions)
    .set({
      reminderSentAt: now,
      updatedAt: sql`now()` as unknown as Date
    })
    .where(
      and(
        eq(sessions.id, id),
        eq(sessions.status, "DECIDED"),
        isNull(sessions.reminderSentAt)
      )
    )
    .returning();
  const row = rows[0];
  return row ? mapSession(row) : undefined;
};

/**
 * Undo a reminder claim when the Discord send fails.
 *
 * @remarks
 * race: revert 自体も CAS。`(status=DECIDED, reminder_sent_at=claimedAt)` 一致時のみ NULL に戻すため、
 *   別経路が COMPLETED へ遷移させたケースで誤って NULL 化しない。
 *   呼び出し側は直前の {@link claimReminderDispatch} で得た `claimedAt` を渡す。
 */
export const revertReminderClaim = async (
  db: DbLike,
  id: string,
  claimedAt: Date
): Promise<boolean> => {
  const rows = await db
    .update(sessions)
    .set({
      reminderSentAt: null,
      updatedAt: sql`now()` as unknown as Date
    })
    .where(
      and(
        eq(sessions.id, id),
        eq(sessions.status, "DECIDED"),
        eq(sessions.reminderSentAt, claimedAt)
      )
    )
    .returning({ id: sessions.id });
  return rows.length > 0;
};
