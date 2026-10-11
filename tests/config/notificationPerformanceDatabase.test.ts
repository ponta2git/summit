import { AsyncLocalStorage } from "node:async_hooks";
import { runInNewContext } from "node:vm";
import { drizzle } from "drizzle-orm/postgres-js";
import { describe, expect, it } from "vitest";
import { notificationPerformanceDatabase } from "../../scripts/perf/notificationPerformance.database.ts";
import { deferred } from "../helpers/deferred.ts";

interface TestDatabase {
  execute(query: string): Promise<unknown>;
  transaction<T>(callback: (tx: TestDatabase) => Promise<T>, options?: { isolationLevel: string }): Promise<T>;
}
interface Counts {
  drizzleStatements: number;
  committedTransactions: number;
  failedTransactions: number;
  estimatedCommittedBeginCommitStatements: number;
}
interface Diagnostics {
  db: TestDatabase;
  enabled: boolean;
  run<T>(command: string, callback: () => Promise<T>): Promise<T>;
  metrics(): { enabled: boolean; byCommand: Record<string, Counts> };
  reset(): void;
}
type Factory = (options: { db: object; schema: object;
  record: (operation: string, milliseconds: number, failed: boolean) => void }) => Diagnostics;

const setup = (enabled = true) => {
  let clock = 0;
  let failGate = false;
  let failCommit = false;
  const beforeQuery = new Map<string, () => Promise<void>>();
  const recorded: { operation: string; milliseconds: number; failed: boolean }[] = [];
  // Substitute only the PostgreSQL transport; use the installed public Drizzle driver/logger/transaction API.
  const client = {
    options: { parsers: {}, serializers: {} },
    unsafe: async (query: string) => {
      await beforeQuery.get(query)?.();
      if (query.includes("pg_advisory_xact_lock")) {
        clock += 7;
        if (failGate) { throw new Error("gate failed"); }
      } else { clock += query.startsWith("set transaction") ? 2 : 4; }
      return [];
    },
    begin: async <T>(callback: (connection: object) => Promise<T>) => {
      clock += 3;
      try {
        const value = await callback(client);
        if (failCommit) { throw new Error("commit failed"); }
        return value;
      } finally { clock += 3; }
    }
  };
  const original = { $client: client };
  // Evaluate the exact container source with explicit public dependencies and a deterministic clock.
  const factory = runInNewContext(notificationPerformanceDatabase.replace(/^import .+;$/gm, "")
    + "\ncreatePerformanceDatabase;", { AsyncLocalStorage, diagnosticDrizzle: drizzle,
    process: { env: { PERF_DATABASE_DIAGNOSTICS: enabled ? "1" : undefined } },
    performance: { now: () => clock } }) as Factory;
  const diagnostics = factory({ db: original, schema: {}, record: (operation, milliseconds, failed) => {
    recorded.push({ operation, milliseconds, failed });
  } });
  return { diagnostics, original, recorded, beforeQuery,
    failGate: () => { failGate = true; }, failCommit: () => { failCommit = true; } };
};
const gate = "SELECT pg_advisory_xact_lock(19790514, 1)";
const transactionOptions = { isolationLevel: "read committed" };

describe("optional notification performance database diagnostics", () => {
  it("returns the original database and directly runs commands while disabled", async () => {
    const h = setup(false);
    expect(h.diagnostics.db).toBe(h.original);
    expect(await h.diagnostics.run("begin", async () => "unchanged")).toBe("unchanged");
    expect(h.diagnostics.metrics()).toEqual({ enabled: false, byCommand: {} });
    expect(h.recorded).toEqual([]);
  });

  it("separates transaction entry, gate round trip and commit-inclusive hold without extra SQL", async () => {
    const { diagnostics, recorded } = setup();
    expect(await diagnostics.run("begin", () => diagnostics.db.transaction(async tx => {
      await tx.execute(gate);
      await tx.execute("SELECT 'private-notification-id' AS value");
      return "result";
    }, transactionOptions))).toBe("result");
    expect(recorded).toEqual([
      { operation: "database.transactionEntry.begin", milliseconds: 5, failed: false },
      { operation: "database.gateCall.begin", milliseconds: 7, failed: false },
      { operation: "database.transactionWall.begin", milliseconds: 19, failed: false },
      { operation: "database.gateHold.begin", milliseconds: 7, failed: false }
    ]);
    expect(diagnostics.metrics()).toEqual({ enabled: true, byCommand: { begin: {
      drizzleStatements: 3, committedTransactions: 1, failedTransactions: 0,
      estimatedCommittedBeginCommitStatements: 2
    } } });
    expect(JSON.stringify([diagnostics.metrics(), recorded])).not.toContain("private-notification-id");
  });

  it("does not invent acquired time or committed control statements when the gate fails", async () => {
    const h = setup(); h.failGate();
    await expect(h.diagnostics.run("claim", () => h.diagnostics.db.transaction(async tx => {
      await tx.execute(gate);
    }, transactionOptions))).rejects.toThrow("Failed query");
    expect(h.recorded).toEqual([
      { operation: "database.transactionEntry.claim", milliseconds: 5, failed: false },
      { operation: "database.gateCall.claim", milliseconds: 7, failed: true },
      { operation: "database.transactionWall.claim", milliseconds: 15, failed: true }
    ]);
    expect(h.diagnostics.metrics().byCommand["claim"]).toEqual({ drizzleStatements: 2,
      committedTransactions: 0, failedTransactions: 1, estimatedCommittedBeginCommitStatements: 0 });
  });

  it("records a post-gate commit failure as failed while awaiting transaction settlement", async () => {
    const h = setup(); h.failCommit();
    await expect(h.diagnostics.run("complete", () => h.diagnostics.db.transaction(async tx => {
      await tx.execute(gate);
    }, transactionOptions))).rejects.toThrow("commit failed");
    expect(h.recorded.slice(-2)).toEqual([
      { operation: "database.transactionWall.complete", milliseconds: 15, failed: true },
      { operation: "database.gateHold.complete", milliseconds: 3, failed: true }
    ]);
    expect(h.diagnostics.metrics().byCommand["complete"]).toMatchObject({ committedTransactions: 0,
      failedTransactions: 1, estimatedCommittedBeginCommitStatements: 0 });
  });

  it("keeps interleaved commands separate, counts non-transaction reads and bounds command labels", async () => {
    const h = setup();
    const entered = deferred<void>(); const release = deferred<void>();
    h.beforeQuery.set(gate, async () => { entered.resolve(); await release.promise; });
    const claiming = h.diagnostics.run("claim", () => h.diagnostics.db.transaction(async tx => {
      await tx.execute(gate);
    }, transactionOptions));
    await entered.promise;
    await h.diagnostics.run("getNextDispatchAt", () => h.diagnostics.db.execute("SELECT 1"));
    await h.diagnostics.run("private-command-value", () => h.diagnostics.db.execute("SELECT 2"));
    release.resolve(); await claiming;
    expect(h.diagnostics.metrics().byCommand).toEqual({
      claim: { drizzleStatements: 2, committedTransactions: 1, failedTransactions: 0,
        estimatedCommittedBeginCommitStatements: 2 },
      getNextDispatchAt: { drizzleStatements: 1, committedTransactions: 0, failedTransactions: 0,
        estimatedCommittedBeginCommitStatements: 0 },
      other: { drizzleStatements: 1, committedTransactions: 0, failedTransactions: 0,
        estimatedCommittedBeginCommitStatements: 0 }
    });
    const snapshot = h.diagnostics.metrics();
    h.diagnostics.reset();
    expect(h.diagnostics.metrics()).toEqual({ enabled: true, byCommand: {} });
    expect(snapshot.byCommand["claim"]?.drizzleStatements).toBe(2);
    expect(JSON.stringify([snapshot, h.recorded])).not.toContain("private-command-value");
  });
});
