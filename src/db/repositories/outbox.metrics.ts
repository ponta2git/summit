import { and, eq, inArray, lte, or, sql } from "drizzle-orm";

import { discordOutbox } from "../schema.js";
import type { DbLike } from "../rows.js";
import { mapOutboxRow, type OutboxEntry } from "./outbox.types.js";

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
}

/**
 * Delete terminal outbox rows past their retention deadline.
 *
 * @remarks
 * invariant: `status IN ('DELIVERED','FAILED')` のみを削除する。PENDING / IN_FLIGHT は
 *   at-least-once 配送と CAS-on-NULL back-fill の正本性を保つため絶対に prune しない。
 *   実装は status 別に 2 DELETE に分け、混在不可能にする。
 * idempotent: 削除のみで状態遷移なし。同一 tick の重複呼び出しに安全。
 * @see ADR-0042
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
  return {
    deliveredPruned: deliveredRows.length,
    failedPruned: failedRows.length
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
 * @see ADR-0043
 */
export const getOutboxMetrics = async (
  db: DbLike,
  now: Date
): Promise<OutboxMetricsResult> => {
  const grouped = await db
    .select({
      status: discordOutbox.status,
      n: sql<number>`count(*)::int`
    })
    .from(discordOutbox)
    .where(inArray(discordOutbox.status, ["PENDING", "IN_FLIGHT", "FAILED"]))
    .groupBy(discordOutbox.status);

  const counts = { pending: 0, inFlight: 0, failed: 0 };
  for (const row of grouped) {
    if (row.status === "PENDING") {counts.pending = Number(row.n);}
    else if (row.status === "IN_FLIGHT") {counts.inFlight = Number(row.n);}
    else if (row.status === "FAILED") {counts.failed = Number(row.n);}
  }

  const [oldestPendingRow] = await db
    .select({ oldest: sql<Date | null>`min(${discordOutbox.createdAt})` })
    .from(discordOutbox)
    .where(eq(discordOutbox.status, "PENDING"));
  const [oldestFailedRow] = await db
    .select({ oldest: sql<Date | null>`min(${discordOutbox.updatedAt})` })
    .from(discordOutbox)
    .where(eq(discordOutbox.status, "FAILED"));

  const ageMs = (d: Date | null | undefined): number | null =>
    d === null || d === undefined ? null : Math.max(0, now.getTime() - d.getTime());

  return {
    pending: counts.pending,
    inFlight: counts.inFlight,
    failed: counts.failed,
    oldestPendingAgeMs: ageMs(oldestPendingRow?.oldest ?? null),
    oldestFailedAgeMs: ageMs(oldestFailedRow?.oldest ?? null)
  };
};
