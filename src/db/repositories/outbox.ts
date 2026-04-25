// source-of-truth: Discord 送信 outbox の DB 境界実装。状態遷移 tx 内で enqueue すれば CAS と同 tx で
//   outbox 行が積まれる。worker は claimNextBatch で取り、成功で DELIVERED / 失敗で FAILED or 再試行。
// @see ADR-0035

import { randomUUID } from "node:crypto";

import { and, eq, inArray, lte, or, sql } from "drizzle-orm";

import {
  OUTBOX_KINDS,
  OUTBOX_STATUSES,
  discordOutbox,
  type OutboxKind,
  type OutboxStatus
} from "../schema.js";
import type { DbLike } from "../rows.js";
import { assertEnum } from "../rows.js";
import { addMs } from "../../time/index.js";

// invariant: worker が payload を rehydrate する際の schema。
//   `kind="send_message"` は新規投稿、`kind="edit_message"` は既存 message の編集。
//   `target` は配送成功時に sessions の対応列へ書き戻す対象。
export type OutboxPayloadTarget = "askMessageId" | "postponeMessageId";

export interface OutboxPayloadBase {
  readonly channelId: string;
  readonly target?: OutboxPayloadTarget;
}

export interface OutboxSendMessagePayload extends OutboxPayloadBase {
  readonly kind: "send_message";
  readonly renderer: string;
  readonly extra?: Record<string, unknown>;
}

export interface OutboxEditMessagePayload extends OutboxPayloadBase {
  readonly kind: "edit_message";
  readonly renderer: string;
  readonly messageId: string;
  readonly extra?: Record<string, unknown>;
}

export type OutboxPayload =
  | OutboxSendMessagePayload
  | OutboxEditMessagePayload;

export interface OutboxEntry {
  readonly id: string;
  readonly kind: OutboxKind;
  readonly sessionId: string;
  readonly payload: OutboxPayload;
  readonly dedupeKey: string;
  readonly status: OutboxStatus;
  readonly attemptCount: number;
  readonly lastError: string | null;
  readonly claimExpiresAt: Date | null;
  readonly nextAttemptAt: Date;
  readonly deliveredAt: Date | null;
  readonly deliveredMessageId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface EnqueueOutboxInput {
  readonly kind: OutboxKind;
  readonly sessionId: string;
  readonly payload: OutboxPayload;
  readonly dedupeKey: string;
}

export interface EnqueueResult {
  readonly id: string;
  readonly skipped: boolean;
}

const mapRow = (row: typeof discordOutbox.$inferSelect): OutboxEntry => ({
  id: row.id,
  kind: assertEnum(OUTBOX_KINDS, row.kind, "outbox kind"),
  sessionId: row.sessionId,
  payload: row.payload as OutboxPayload,
  dedupeKey: row.dedupeKey,
  status: assertEnum(OUTBOX_STATUSES, row.status, "outbox status"),
  attemptCount: row.attemptCount,
  lastError: row.lastError,
  claimExpiresAt: row.claimExpiresAt,
  nextAttemptAt: row.nextAttemptAt,
  deliveredAt: row.deliveredAt,
  deliveredMessageId: row.deliveredMessageId,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt
});

/**
 * Insert an outbox row; idempotent via `dedupe_key` partial unique index.
 *
 * @remarks
 * tx: state transition の tx を渡せば CAS と enqueue が atomic。tx なしなら独立 tx で挿入。
 * idempotent: `uq_discord_outbox_dedupe_active` により同 dedupe_key 2 回目以降は `onConflictDoNothing`
 *   で弾かれ skipped=true を返す。
 * @see ADR-0035
 */
export const enqueueOutbox = async (
  db: DbLike,
  input: EnqueueOutboxInput
): Promise<EnqueueResult> => {
  const id = randomUUID();
  const rows = await db
    .insert(discordOutbox)
    .values({
      id,
      kind: input.kind,
      sessionId: input.sessionId,
      payload: input.payload,
      dedupeKey: input.dedupeKey
    })
    .onConflictDoNothing({
      target: discordOutbox.dedupeKey,
      // race: partial unique index の述語と一致させないと ON CONFLICT が index を解決できない。
      where: sql`${discordOutbox.status} IN ('PENDING','IN_FLIGHT','DELIVERED')`
    })
    .returning({ id: discordOutbox.id });
  const inserted = rows[0];
  if (inserted) {
    return { id: inserted.id, skipped: false };
  }
  // why: onConflictDoNothing は既存行を返さないため、dedup hit の id を別クエリで拾う。
  const existing = await db
    .select({ id: discordOutbox.id })
    .from(discordOutbox)
    .where(eq(discordOutbox.dedupeKey, input.dedupeKey))
    .limit(1);
  const hit = existing[0];
  return { id: hit?.id ?? id, skipped: true };
};

/**
 * Atomically claim up to `limit` deliverable rows for a worker tick.
 *
 * @remarks
 * race: PENDING もしくは expired IN_FLIGHT を候補に、`AND status IN ('PENDING','IN_FLIGHT')` を CAS 条件として
 *   `UPDATE ... WHERE id IN (...)` を tx 内で実行。候補取得と UPDATE の間で他 worker / reconciler が
 *   状態を変えた行は自動的に除外される。
 * single-instance: ADR-0001 で 1 インスタンス前提だが、noOverlap 境界の二重実行は CAS で吸収する。
 * idempotent: DELIVERED / FAILED は対象外。stale IN_FLIGHT のみ再 claim される。
 */
export const claimNextOutboxBatch = async (
  db: DbLike,
  options: { readonly limit: number; readonly now: Date; readonly claimDurationMs: number }
): Promise<readonly OutboxEntry[]> => {
  const claimExpiresAt = addMs(options.now, options.claimDurationMs);
  return db.transaction(async (tx) => {
    const candidates = await tx
      .select({ id: discordOutbox.id })
      .from(discordOutbox)
      .where(
        or(
          and(
            eq(discordOutbox.status, "PENDING"),
            lte(discordOutbox.nextAttemptAt, options.now)
          ),
          and(
            eq(discordOutbox.status, "IN_FLIGHT"),
            lte(discordOutbox.claimExpiresAt, options.now)
          )
        )
      )
      .orderBy(discordOutbox.nextAttemptAt)
      .limit(options.limit);
    if (candidates.length === 0) {
      return [];
    }
    const ids = candidates.map((c) => c.id);
    const rows = await tx
      .update(discordOutbox)
      .set({
        status: "IN_FLIGHT",
        claimExpiresAt,
        attemptCount: sql`${discordOutbox.attemptCount} + 1`,
        updatedAt: options.now
      })
      .where(
        and(
          inArray(discordOutbox.id, ids),
          inArray(discordOutbox.status, ["PENDING", "IN_FLIGHT"])
        )
      )
      .returning();
    return rows.map(mapRow);
  });
};

/**
 * Mark a claimed outbox row as delivered.
 *
 * @remarks
 * state: `status=IN_FLIGHT → DELIVERED` の CAS。マッチしなければ no-op。
 */
export const markOutboxDelivered = async (
  db: DbLike,
  id: string,
  options: { readonly deliveredMessageId: string | null; readonly now: Date }
): Promise<boolean> => {
  const rows = await db
    .update(discordOutbox)
    .set({
      status: "DELIVERED",
      deliveredAt: options.now,
      deliveredMessageId: options.deliveredMessageId,
      claimExpiresAt: null,
      updatedAt: options.now
    })
    .where(and(eq(discordOutbox.id, id), eq(discordOutbox.status, "IN_FLIGHT")))
    .returning({ id: discordOutbox.id });
  return rows.length > 0;
};

/**
 * Mark a claimed row as failed with exponential backoff, or dead-letter when `nextAttemptAt` is null.
 *
 * @remarks
 * state: `nextAttemptAt=now+backoff` で PENDING に戻すか、上限超過なら FAILED 終端。
 * idempotent: IN_FLIGHT でなければ no-op。
 */
export const markOutboxFailed = async (
  db: DbLike,
  id: string,
  options: {
    readonly error: string;
    readonly now: Date;
    readonly nextAttemptAt: Date | null;
  }
): Promise<boolean> => {
  const rows = await db
    .update(discordOutbox)
    .set({
      status: options.nextAttemptAt === null ? "FAILED" : "PENDING",
      lastError: options.error.slice(0, 4000),
      claimExpiresAt: null,
      nextAttemptAt: options.nextAttemptAt ?? options.now,
      updatedAt: options.now
    })
    .where(and(eq(discordOutbox.id, id), eq(discordOutbox.status, "IN_FLIGHT")))
    .returning({ id: discordOutbox.id });
  return rows.length > 0;
};

/**
 * Release IN_FLIGHT rows whose `claim_expires_at` has passed (startup crash recovery).
 *
 * @remarks
 * race: worker が `markDelivered` / `markFailed` を呼ぶ前に crash すると IN_FLIGHT で stuck する。
 *   reconciler が startup 時に PENDING へ戻し、次 tick で再配送させる。
 * @see ADR-0033, ADR-0035
 */
export const releaseExpiredOutboxClaims = async (
  db: DbLike,
  now: Date
): Promise<number> => {
  const rows = await db
    .update(discordOutbox)
    .set({
      status: "PENDING",
      claimExpiresAt: null,
      nextAttemptAt: now,
      updatedAt: now
    })
    .where(
      and(
        eq(discordOutbox.status, "IN_FLIGHT"),
        lte(discordOutbox.claimExpiresAt, now)
      )
    )
    .returning({ id: discordOutbox.id });
  return rows.length;
};

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
  return rows.map(mapRow);
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
