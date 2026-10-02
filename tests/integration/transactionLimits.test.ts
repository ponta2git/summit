import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { runTransaction } from "../../src/db/transaction.ts";
import { sessions } from "../../src/db/schema.ts";
import { deferred } from "../helpers/deferred.ts";
import { makeSession } from "../testing/fixtures.ts";
import { createIntegrationDb, isIntegration, truncatePerTestTables } from "./_support.ts";

(isIntegration ? describe : describe.skip)("database transaction limits", () => {
  const { db, client } = createIntegrationDb();
  const blocker = createIntegrationDb();
  beforeEach(() => truncatePerTestTables(db));
  afterAll(async () => { await Promise.all([client.end({ timeout: 5 }), blocker.client.end({ timeout: 5 })]); });

  const settings = async (): Promise<unknown> => db.execute(sql`SELECT
    current_setting('lock_timeout') AS lock, current_setting('statement_timeout') AS statement`);

  it("keeps limits local to the transaction on commit and rollback", async () => {
    const before = await settings();
    expect(await runTransaction(db, tx => tx.execute(sql`SELECT
      current_setting('lock_timeout') AS lock, current_setting('statement_timeout') AS statement`)))
      .toEqual([{ lock: "5s", statement: "10s" }]);
    expect(await settings()).toEqual(before);
    await expect(runTransaction(db, async () => { throw new Error("abort"); })).rejects.toThrow("abort");
    expect(await settings()).toEqual(before);
  });

  it("rolls back prior writes after a real SQL deadline and leaves the connection reusable", async () => {
    await expect(runTransaction(db, async tx => {
      await tx.insert(sessions).values(makeSession());
      await tx.execute(sql`SELECT pg_sleep(10)`);
    }, { lockTimeoutMs: 50, statementTimeoutMs: 150 })).rejects.toMatchObject({ cause: { code: "57014" } });
    expect(await db.select().from(sessions)).toEqual([]);
    expect(await runTransaction(db, tx => tx.insert(sessions).values(makeSession()).returning({ id: sessions.id })))
      .toEqual([{ id: "session-1" }]);
  });

  it("bounds lock waits and rolls back the entire command before releasing its owner", async () => {
    const locked = deferred<void>();
    const release = deferred<void>();
    const holding = blocker.db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(25010, 1)`);
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    try {
      await expect(runTransaction(db, async tx => {
        await tx.insert(sessions).values(makeSession());
        await tx.execute(sql`SELECT pg_advisory_xact_lock(25010, 1)`);
      }, { lockTimeoutMs: 100, statementTimeoutMs: 1_000 })).rejects.toMatchObject({ cause: { code: "55P03" } });
      expect(await db.select().from(sessions)).toEqual([]);
    } finally { release.resolve(); await holding; }
    expect(await runTransaction(db, tx => tx.execute(sql`SELECT 1 AS ready`))).toEqual([{ ready: 1 }]);
  });
});
