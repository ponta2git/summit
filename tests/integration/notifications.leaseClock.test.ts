import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { makeResultNotificationsPort } from "../../src/db/repositories/resultNotifications.ts";
import { lockNotificationFamily } from "../../src/db/repositories/notifications.storage.ts";
import { discordNotifications, discordNotificationParts } from "../../src/db/schema.ts";
import { claimLeaseRemainingMs } from "../../src/time/lease.ts";
import { notificationNow, ocrReceiptPayload } from "../contracts/resultNotifications.ts";
import { deferred } from "../helpers/deferred.ts";
import { checkNotificationAdmission, createResultNotificationHarness } from "./_resultNotifications.ts";
import { waitForBlockedBy } from "./locking.ts";
import { isIntegration } from "./_support.ts";

const at = (ms: number): Date => new Date(notificationNow.getTime() + ms);

(isIntegration ? describe : describe.skip)("notification lease clock at the database boundary", () => {
  let h: Awaited<ReturnType<typeof createResultNotificationHarness>>;
  beforeEach(async () => { h = await createResultNotificationHarness(); await h.port.receive(JSON.stringify(ocrReceiptPayload()), notificationNow); });

  const holdGate = async () => {
    const locked = deferred<number>(); const release = deferred<void>();
    const transaction = h.db.transaction(async tx => {
      await lockNotificationFamily(tx, "result");
      const [row] = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      if (!row) { throw new Error("Missing lock holder"); }
      locked.resolve(row.pid); await release.promise;
    });
    return { pid: await locked.promise, release: async () => { release.resolve(); await transaction; } };
  };

  it("starts the claim duration after the family gate instead of backdating it to queue entry", async () => {
    let ms = 0; const clock = { now: () => at(ms), monotonicNow: () => ms };
    const port = makeResultNotificationsPort(h.db, checkNotificationAdmission, clock);
    const gate = await holdGate();
    const pending = port.claim({ limit: 1, now: notificationNow, claimDurationMs: 30_000 });
    try { await waitForBlockedBy(h.client, gate.pid); ms = 20_000; }
    finally { await gate.release(); }
    const [claim] = await pending;
    expect(claim?.lease).toEqual({ observedAt: at(20_000), observedMonotonicMs: 20_000, expiresAt: at(50_000) });
    expect(await h.db.select({ expiresAt: discordNotifications.claimExpiresAt }).from(discordNotifications))
      .toEqual([{ expiresAt: at(50_000) }]);
  });

  it.each(["begin", "renew"] as const)("rejects %s that crosses expiry while waiting for the gate", async operation => {
    let ms = 0; const clock = { now: () => at(ms), monotonicNow: () => ms };
    const port = makeResultNotificationsPort(h.db, checkNotificationAdmission, clock);
    const [claim] = await port.claim({ limit: 1, now: notificationNow, claimDurationMs: 30_000 });
    if (!claim) { throw new Error("Expected claim"); }
    await port.plan(claim.id, claim.claimToken, { count: 1, rendererVersion: 1,
      context: { channelId: "channel", webOrigin: "https://example.test" }, now: notificationNow });
    const gate = await holdGate();
    const pending = operation === "begin" ? port.begin(claim.id, 0, claim.claimToken, at(1))
      : port.renew(claim.id, claim.claimToken, at(1), 30_000);
    try { await waitForBlockedBy(h.client, gate.pid); ms = 30_000; }
    finally { await gate.release(); }
    expect(await pending).toBe(operation === "begin" ? false : null);
    expect(await h.db.select({ status: discordNotificationParts.status, attempts: discordNotificationParts.attemptCount })
      .from(discordNotificationParts).where(eq(discordNotificationParts.notificationId, claim.id)))
      .toEqual([{ status: "PENDING", attempts: 0 }]);
  });

  it("subtracts hydration and committed-response delay from the observed lease", async () => {
    let ms = 0; const clock = { now: () => at(ms), monotonicNow: () => ms };
    const committed = deferred<void>(); const reply = deferred<void>();
    const delayedTransaction: typeof h.db.transaction = async (callback, config) => {
      const result = await h.db.transaction(callback, config);
      committed.resolve(); await reply.promise; return result;
    };
    const delayedDb = new Proxy(h.db, { get: (target, key, receiver) => key === "transaction" ? delayedTransaction : Reflect.get(target, key, receiver) });
    const port = makeResultNotificationsPort(delayedDb, checkNotificationAdmission, clock);
    const pending = port.claim({ limit: 1, now: notificationNow, claimDurationMs: 30_000 });
    await committed.promise; ms = 31_000; reply.resolve();
    const [claim] = await pending;
    if (!claim) { throw new Error("Expected committed claim"); }
    expect(claim.lease).toEqual({ observedAt: at(0), observedMonotonicMs: 0, expiresAt: at(30_000) });
    expect(claimLeaseRemainingMs(claim.lease, clock)).toBe(-1_000);
    expect(await h.port.inspect(claim.id)).toMatchObject({ attemptCount: 1, claimExpiresAt: at(30_000) });
  });

  it("recovers a lost renewal response using the same token without another claim or attempt", async () => {
    let ms = 0; const clock = { now: () => at(ms), monotonicNow: () => ms };
    const port = makeResultNotificationsPort(h.db, checkNotificationAdmission, clock);
    const [claim] = await port.claim({ limit: 1, now: notificationNow, claimDurationMs: 30_000 });
    if (!claim) { throw new Error("Expected claim"); }
    const lostReply: typeof h.db.transaction = async (callback, config) => {
      await h.db.transaction(callback, config); throw new Error("Commit applied; reply lost");
    };
    const unavailable = makeResultNotificationsPort(new Proxy(h.db, {
      get: (target, key, receiver) => key === "transaction" ? lostReply : Reflect.get(target, key, receiver)
    }), checkNotificationAdmission, clock);
    ms = 10_000;
    await expect(unavailable.renew(claim.id, claim.claimToken, at(10_000), 30_000)).rejects.toThrow("Notification database operation failed");
    expect(await h.port.inspect(claim.id)).toMatchObject({ claimExpiresAt: at(40_000) });
    ms = 11_000;
    expect(await port.renew(claim.id, claim.claimToken, at(11_000), 30_000))
      .toEqual({ observedAt: at(11_000), observedMonotonicMs: 11_000, expiresAt: at(41_000) });
    expect(await h.port.inspect(claim.id)).toMatchObject({ attemptCount: 1, claimExpiresAt: at(41_000) });
  });
});
