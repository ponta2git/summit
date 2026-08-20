import { and, eq, inArray, lte, or, sql } from "drizzle-orm";

import { discordOutbox } from "../schema.ts";
import { parseDbTimestamp, type DbLike } from "../rows.ts";
import { mapOutboxRow, type OutboxEntry } from "./outbox.types.ts";

/**
 * Return stranded outbox rows for `/status` invariant warning.
 *
 * @remarks
 * FAILED (dead letter) と attempt_count が警告閾値超の PENDING / IN_FLIGHT を返す。
 */
export const findStrandedOutboxEntries = async (
  db: DbLike,
  attemptsThreshold: number
): Promise<readonly OutboxEntry[]> => {
  const rows = await db
    .select()
    .from(discordOutbox)
    .where(
      or(
        eq(discordOutbox.status, "FAILED"),
        and(
          inArray(discordOutbox.status, ["PENDING", "IN_FLIGHT"]),
          sql`${discordOutbox.attemptCount} >= ${attemptsThreshold}`
        )
      )
    );
  return rows.map(mapOutboxRow);
};

export interface PruneOutboxResult {
  readonly deliveredPruned: number;
  readonly failedPruned: number;
  readonly cancelledPruned: number;
}

/**
 * Delete terminal outbox rows past their retention deadline.
 *
 * @remarks
 * invariant: `status IN ('DELIVERED','FAILED','CANCELLED')` のみを削除する。PENDING / IN_FLIGHT は
 *   at-least-once 配送と CAS-on-NULL back-fill の正本性を保つため絶対に prune しない。
 *   実装は status 別に DELETE を分け、混在不可能にする。CANCELLED は失敗系と同じ
 *   retention window を使い、先行 intent の dead-letter 後も監査期間を確保する。
 * idempotent: 削除のみで状態遷移なし。同一 tick の重複呼び出しに安全。
 */
export const pruneOutbox = async (
  db: DbLike,
  options: {
    readonly deliveredOlderThan: Date;
    readonly failedOlderThan: Date;
  }
): Promise<PruneOutboxResult> => {
  const deliveredRows = await db
    .delete(discordOutbox)
    .where(
      and(
        eq(discordOutbox.status, "DELIVERED"),
        lte(discordOutbox.deliveredAt, options.deliveredOlderThan)
      )
    )
    .returning({ id: discordOutbox.id });
  const failedRows = await db
    .delete(discordOutbox)
    .where(
      and(
        eq(discordOutbox.status, "FAILED"),
        lte(discordOutbox.updatedAt, options.failedOlderThan)
      )
    )
    .returning({ id: discordOutbox.id });
  const cancelledRows = await db
    .delete(discordOutbox)
    .where(
      and(
        eq(discordOutbox.status, "CANCELLED"),
        lte(discordOutbox.updatedAt, options.failedOlderThan)
      )
    )
    .returning({ id: discordOutbox.id });
  return {
    deliveredPruned: deliveredRows.length,
    failedPruned: failedRows.length,
    cancelledPruned: cancelledRows.length
  };
};

export interface OutboxMetricsResult {
  readonly pending: number;
  readonly inFlight: number;
  readonly failed: number;
  readonly oldestPendingAgeMs: number | null;
  readonly oldestFailedAgeMs: number | null;
}

/**
 * Snapshot outbox depth and age metrics for periodic observability logging.
 *
 * @remarks
 * idempotent: read-only snapshot。observability 用途で同一 tick の重複呼び出しに副作用なし。
 */
export const getOutboxMetrics = async (
  db: DbLike,
  now: Date
): Promise<OutboxMetricsResult> => {
  const [row] = await db
    .select({
      pending: sql<number>`count(*) filter (where ${discordOutbox.status} = 'PENDING')::int`,
      inFlight: sql<number>`count(*) filter (where ${discordOutbox.status} = 'IN_FLIGHT')::int`,
      failed: sql<number>`count(*) filter (where ${discordOutbox.status} = 'FAILED')::int`,
      oldestPending: sql<unknown>`min(${discordOutbox.createdAt}) filter (where ${discordOutbox.status} = 'PENDING')`,
      oldestFailed: sql<unknown>`min(${discordOutbox.updatedAt}) filter (where ${discordOutbox.status} = 'FAILED')`
    })
    .from(discordOutbox);

  const ageMs = (value: unknown, label: string): number | null => {
    const date = parseDbTimestamp(value, label);
    return date === null ? null : Math.max(0, now.getTime() - date.getTime());
  };

  return {
    pending: Number(row?.pending ?? 0),
    inFlight: Number(row?.inFlight ?? 0),
    failed: Number(row?.failed ?? 0),
    oldestPendingAgeMs: ageMs(row?.oldestPending ?? null, "oldest pending outbox timestamp"),
    oldestFailedAgeMs: ageMs(row?.oldestFailed ?? null, "oldest failed outbox timestamp")
  };
};

/**
 * Return the next timestamp at which an outbox row needs worker attention.
 *
 * @remarks
 * source-of-truth: PENDING rows wake at `next_attempt_at`; IN_FLIGHT rows wake at
 * `claim_expires_at` so a crashed worker can be reclaimed without empty polling.
 */
export const getNextOutboxDispatchAt = async (
  db: DbLike,
  _now: Date
): Promise<Date | null> => {
  const [row] = await db
    .select({
      next: sql<unknown>`
        min(
          case
            when ${discordOutbox.status} = 'PENDING' then ${discordOutbox.nextAttemptAt}
            when ${discordOutbox.status} = 'IN_FLIGHT' then ${discordOutbox.claimExpiresAt}
            else null
          end
        )
      `
    })
    .from(discordOutbox)
    .where(inArray(discordOutbox.status, ["PENDING", "IN_FLIGHT"]));
  return parseDbTimestamp(row?.next ?? null, "next outbox dispatch timestamp");
};
