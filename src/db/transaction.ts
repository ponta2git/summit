import { sql } from "drizzle-orm";
import type { DbLike } from "./rows.ts";

export type DbTransaction = Parameters<Parameters<DbLike["transaction"]>[0]>[0];

export interface TransactionLimits {
  readonly lockTimeoutMs: number;
  readonly statementTimeoutMs: number;
}

const DEFAULT_LIMITS: TransactionLimits = { lockTimeoutMs: 5_000, statementTimeoutMs: 10_000 };

/** Bound SQL and lock waits without releasing ownership before rollback has settled. */
export const runTransaction = <T>(
  db: DbLike,
  command: (tx: DbTransaction) => Promise<T>,
  limits: TransactionLimits = DEFAULT_LIMITS
): Promise<T> => {
  if (!Number.isSafeInteger(limits.lockTimeoutMs) || limits.lockTimeoutMs < 1
    || !Number.isSafeInteger(limits.statementTimeoutMs) || limits.statementTimeoutMs <= limits.lockTimeoutMs) {
    return Promise.reject(new Error("Invalid database transaction limits"));
  }
  return db.transaction(async tx => {
    // pooler: transaction-local settings cannot leak into the next pooled borrower.
    await tx.execute(sql`SELECT
      set_config('lock_timeout', ${String(limits.lockTimeoutMs)}, true),
      set_config('statement_timeout', ${String(limits.statementTimeoutMs)}, true)`);
    return command(tx);
  }, { isolationLevel: "read committed" });
};
