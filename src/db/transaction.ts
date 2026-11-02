import { sql } from "drizzle-orm";
import type { DbLike } from "./rows.ts";
import { identityLayout, inheritIdentityLayout } from "./identities.ts";

export type DbTransaction = Parameters<Parameters<DbLike["transaction"]>[0]>[0];

interface TransactionLimits {
  readonly lockTimeoutMs: number;
  readonly statementTimeoutMs: number;
}

const DEFAULT_LIMITS: TransactionLimits = { lockTimeoutMs: 5_000, statementTimeoutMs: 10_000 };
const transactionHandles = new WeakSet<object>();
export const isTransactionHandle = (db: object): boolean => transactionHandles.has(db);

/** Bound SQL and lock waits without releasing ownership before rollback has settled. */
export const runTransaction = async <T>(
  db: DbLike,
  command: (tx: DbTransaction) => Promise<T>,
  limits: TransactionLimits = DEFAULT_LIMITS
): Promise<T> => {
  if (!Number.isSafeInteger(limits.lockTimeoutMs) || limits.lockTimeoutMs < 1 || limits.lockTimeoutMs > 2_147_483_647
    || !Number.isSafeInteger(limits.statementTimeoutMs) || limits.statementTimeoutMs <= limits.lockTimeoutMs
    || limits.statementTimeoutMs > 2_147_483_647) {
    return Promise.reject(new Error("Invalid database transaction limits"));
  }
  const layout = await identityLayout(db);
  return db.transaction(async tx => {
    transactionHandles.add(tx);
    inheritIdentityLayout(tx, layout);
    // pooler: transaction-local settings cannot leak into the next pooled borrower.
    // Only validated integer configuration is inlined, through the dialect's escaping. Request data stays bound.
    // With prepare:false, a parameter-free statement avoids the separate parameter Describe round trip.
    await tx.execute(sql`SELECT
      set_config('lock_timeout', ${String(limits.lockTimeoutMs)}, true),
      set_config('statement_timeout', ${String(limits.statementTimeoutMs)}, true)`.inlineParams());
    return command(tx);
  }, { isolationLevel: "read committed" });
};
