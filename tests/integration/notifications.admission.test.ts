import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { notificationAdmissionFor } from "../../src/db/notificationControl.ts";
import { lockNotificationFamily, notificationTransaction } from "../../src/db/repositories/notifications.storage.ts";
import { releaseExpiredOutboxClaims } from "../../src/db/repositories/outbox.claim.ts";
import { discordNotifications } from "../../src/db/schema.ts";
import { identityLayout } from "../../src/db/identities.ts";
import { makeResultNotificationsPort } from "../../src/db/repositories/resultNotifications.ts";
import { InvariantViolationError } from "../../src/errors/index.ts";
import { checkNotificationAdmission, createResultNotificationHarness } from "./_resultNotifications.ts";
import { repositoryClock } from "./_notificationClock.ts";
import { notificationNow, ocrReceiptPayload } from "../contracts/resultNotifications.ts";
import { deferredSignal } from "../helpers/deferred.ts";
import { waitForLockWaiters } from "./locking.ts";
import { isIntegration } from "./_support.ts";

(isIntegration ? describe : describe.skip)("notification admission across real transaction settlement", () => {
  let harness: Awaited<ReturnType<typeof createResultNotificationHarness>>;
  beforeEach(async () => {
    harness = await createResultNotificationHarness();
    await harness.port.receive(JSON.stringify(ocrReceiptPayload()), notificationNow);
  });

  it.each(["before_gate", "holding_gate", "after_update", "after_commit"] as const)(
    "retains ownership during %s response loss and permits the other family to renew", async phase => {
      const reached = deferredSignal(); const release = deferredSignal(); const secondEntered = deferredSignal();
      const releaseSecond = deferredSignal();
      let firstTransaction = true;
      const transaction: typeof harness.db.transaction = async (callback, config) => {
        const first = firstTransaction; firstTransaction = false;
        const value = await harness.db.transaction(async tx => {
          let statements = 0;
          const execute = <TRow extends Record<string, unknown>>(query: Parameters<typeof tx.execute>[0]) => {
            const gate = ++statements === 2;
            const raw = tx.execute<TRow>(query);
            const delayed = async () => {
              if (first && gate && phase === "before_gate") { reached.resolve(); await release.promise; }
              const rows = await raw;
              if (first && gate && phase === "holding_gate") { reached.resolve(); await release.promise; }
              return rows;
            };
            const then: typeof raw.then = (fulfilled, rejected) => delayed().then(fulfilled, rejected);
            return new Proxy(raw, { get: (target, key, receiver) => key === "then" ? then : Reflect.get(target, key, receiver) });
          };
          const observed = new Proxy(tx, { get: (target, key, receiver) => key === "execute" ? execute : Reflect.get(target, key, receiver) });
          return callback(observed);
        }, config);
        if (first && phase === "after_commit") { reached.resolve(); await release.promise; }
        return value;
      };
      const db = new Proxy(harness.db, { get: (target, key, receiver) => key === "transaction" ? transaction : Reflect.get(target, key, receiver) });
      await identityLayout(db);
      const admission = notificationAdmissionFor(db);
      const first = notificationTransaction(db, "result", async tx => {
        await tx.update(discordNotifications).set({ lastError: "response_lost" });
        if (phase === "after_update") { reached.resolve(); await release.promise; }
        return true;
      }, { key: "first", operation: "finalize" });
      await reached.promise;
      const second = notificationTransaction(db, "result", async tx => {
        await tx.execute(sql`SELECT 1`); secondEntered.resolve(); await releaseSecond.promise; return true;
      }, { key: "second", operation: "finalize" });
      let thirdStarted = false;
      const third = notificationTransaction(db, "result", async tx => { thirdStarted = true; await tx.execute(sql`SELECT 1`); return true; },
        { key: "third", operation: "claim" });
      try {
        if (phase === "before_gate" || phase === "after_commit") { await secondEntered.promise; }
        else { await waitForLockWaiters(harness.client, 1); }
        expect(admission.snapshot()).toMatchObject({ result: 2, running: 2, waiting: 1 });
        expect(thirdStarted).toBe(false);
        expect(await notificationTransaction(db, "attendance", async tx => {
          const [row] = await tx.execute<{ value: number }>(sql`SELECT 1 AS value`); return row?.value;
        }, { key: "other-renew", operation: "renew", remainingMs: () => 10_000 })).toBe(1);
        expect(admission.snapshot()).toMatchObject({ result: 2, attendance: 0, waiting: 1 });
        let progress: { readonly lastError: string | null | undefined; readonly second: boolean; readonly third: boolean; readonly running: number } | undefined;
        if (phase === "after_commit") {
          const [persisted] = await harness.db.select({ lastError: discordNotifications.lastError }).from(discordNotifications);
          releaseSecond.resolve();
          progress = { lastError: persisted?.lastError, second: await second, third: await third, running: admission.snapshot().running };
        }
        expect(progress).toEqual(phase === "after_commit" ? { lastError: "response_lost", second: true, third: true, running: 1 } : undefined);
      } finally {
        release.resolve(); releaseSecond.resolve(); await Promise.all([first, second, third]); await admission.drain();
      }
      expect(admission.snapshot()).toMatchObject({ running: 0, waiting: 0 });
    }
  );

  it("returns stopped queued begin/claim as no-ops without SQL or another delivery attempt", async () => {
    const port = makeResultNotificationsPort(harness.db, checkNotificationAdmission, repositoryClock);
    const [claim] = await port.claim({ limit: 1, now: notificationNow, claimDurationMs: 30_000 });
    if (!claim) { throw new Error("Expected claim"); }
    await port.plan(claim.id, claim.claimToken, { count: 1, rendererVersion: 1,
      context: { channelId: "channel", webOrigin: "https://example.test" }, now: notificationNow });
    // Separate root handle represents this process's lifecycle; the fixture observer stays available after stop.
    const db = new Proxy(harness.db, {}); const stoppedPort = makeResultNotificationsPort(db, checkNotificationAdmission, repositoryClock);
    const admission = notificationAdmissionFor(db); const release = deferredSignal(); const entered = deferredSignal();
    const first = notificationTransaction(db, "result", async () => { entered.resolve(); await release.promise; }, { key: "first", operation: "finalize" });
    await entered.promise;
    const second = notificationTransaction(db, "result", async () => undefined, { key: "second", operation: "finalize" });
    await waitForLockWaiters(harness.client, 1);
    const begin = stoppedPort.begin(claim.id, 0, claim.claimToken, notificationNow, () => 30_000);
    const nextClaim = stoppedPort.claim({ limit: 1, now: notificationNow, claimDurationMs: 30_000 });
    try {
      admission.stop(); expect(await begin).toBe(false); expect(await nextClaim).toEqual([]);
    } finally { release.resolve(); await Promise.all([first, second]); await admission.drain(); }
    expect(await harness.port.inspect(claim.id)).toMatchObject({ attemptCount: 1, parts: [{ status: "PENDING", attemptCount: 0 }] });
    expect(await harness.db.select({ status: discordNotifications.status }).from(discordNotifications).where(eq(discordNotifications.id, claim.id)))
      .toEqual([{ status: "IN_FLIGHT" }]);
  });

  it("preserves an internal producer invariant through the port's driver-error sanitizer", async () => {
    const admission = notificationAdmissionFor(harness.db); const release = deferredSignal();
    const first = admission.run({ family: "result", key: "result:claim", operation: "claim" }, () => release.promise);
    try {
      await expect(harness.port.claim({ limit: 1, now: notificationNow, claimDurationMs: 30_000 })).rejects.toBeInstanceOf(InvariantViolationError);
    } finally { release.resolve(); await first; }
  });

  it("coalesces reconnect and supervisor claim recovery on the same root handle", async () => {
    const entered = deferredSignal(); const release = deferredSignal();
    const holder = harness.db.transaction(async tx => {
      await lockNotificationFamily(tx, "attendance"); entered.resolve(); await release.promise;
    });
    await entered.promise;
    const reconnect = releaseExpiredOutboxClaims(harness.db, notificationNow);
    const supervisor = releaseExpiredOutboxClaims(harness.db, new Date(notificationNow.getTime() + 1));
    try {
      expect(supervisor).toBe(reconnect);
      await waitForLockWaiters(harness.client, 1);
      expect(notificationAdmissionFor(harness.db).snapshot()).toMatchObject({ attendance: 1, waiting: 0 });
    } finally { release.resolve(); await holder; }
    expect(await Promise.all([reconnect, supervisor])).toEqual([0, 0]);
    const later = releaseExpiredOutboxClaims(harness.db, notificationNow);
    expect(later).not.toBe(reconnect); expect(await later).toBe(0);
  });
});
