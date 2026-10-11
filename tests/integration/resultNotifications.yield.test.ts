import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { discordNotifications as notifications } from "../../src/db/schema.ts";
import { notificationTransaction } from "../../src/db/repositories/notifications.storage.ts";
import { yieldResultNotification } from "../../src/db/repositories/resultNotifications.yield.ts";
import { notificationNow as now, ocrReceiptPayload } from "../contracts/resultNotifications.ts";
import { analysisNotification } from "../features/result-notifications/fixtures.ts";
import { deferred } from "../helpers/deferred.ts";
import { createResultNotificationHarness } from "./_resultNotifications.ts";
import { isIntegration } from "./_support.ts";
import { waitForBlockedBy } from "./locking.ts";

const at = (milliseconds: number): Date => new Date(now.getTime() + milliseconds);
const context = { channelId: "frozen-channel", webOrigin: "https://example.test" };

(isIntegration ? describe : describe.skip)("result notification handoff transaction boundaries", () => {
  let h: Awaited<ReturnType<typeof createResultNotificationHarness>>;
  beforeEach(async () => { h = await createResultNotificationHarness(); });
  const prepare = async () => {
    await h.port.receive(JSON.stringify(analysisNotification()), now);
    const [entry] = await h.port.claim({ limit: 1, now, claimDurationMs: 30_000 });
    if (!entry) { throw new Error("Expected analysis claim"); }
    await h.port.plan(entry.id, entry.claimToken, { count: 2, rendererVersion: 1, context, now });
    await h.port.begin(entry.id, 0, entry.claimToken, at(1));
    await h.port.complete(entry.id, 0, entry.claimToken, "already-sent", at(2));
    await h.port.receive(JSON.stringify(ocrReceiptPayload()), at(3));
    return entry;
  };

  it("serializes an in-progress heartbeat behind handoff commit and rejects the released owner", async () => {
    const entry = await prepare(); const locked = deferred<number>(); const release = deferred<void>();
    const handingOff = notificationTransaction(h.db, "result", async tx => {
      const changed = await yieldResultNotification(tx, entry.id, entry.claimToken, at(4));
      const [backend] = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      if (!backend) { throw new Error("Expected handoff backend"); }
      locked.resolve(backend.pid); await release.promise; return changed;
    });
    const pid = await locked.promise;
    const renewing = h.port.renew(entry.id, entry.claimToken, at(5), 30_000);
    try {
      await waitForBlockedBy(h.client, pid);
      // The completed message and handoff become visible at separate commits;
      // the observer still sees the original claim while handoff is uncommitted.
      expect(await h.db.select({ status: notifications.status, attemptCount: notifications.attemptCount,
        claimToken: notifications.claimToken }).from(notifications).where(eq(notifications.id, entry.id)))
        .toEqual([{ status: "IN_FLIGHT", attemptCount: 1, claimToken: entry.claimToken }]);
    } finally { release.resolve(); await handingOff; }
    expect(await handingOff).toBe(true); expect(await renewing).toBe(false);
    expect(await h.port.inspect(entry.id)).toMatchObject({ status: "PENDING", attemptCount: 0, claimExpiresAt: null,
      parts: [{ status: "DELIVERED", deliveredMessageId: "already-sent" }, { status: "PENDING" }] });
  });

  it("rolls back the handoff and attempt credit while preserving the prior message commit", async () => {
    const entry = await prepare();
    await expect(notificationTransaction(h.db, "result", async tx => {
      expect(await yieldResultNotification(tx, entry.id, entry.claimToken, at(4))).toBe(true);
      throw new Error("abort handoff before commit");
    })).rejects.toThrow("abort handoff before commit");
    expect(await h.port.inspect(entry.id)).toMatchObject({ status: "IN_FLIGHT", attemptCount: 1, claimExpiresAt: at(30_000),
      parts: [{ status: "DELIVERED", deliveredMessageId: "already-sent" }, { status: "PENDING" }] });
    expect(await h.port.begin(entry.id, 1, entry.claimToken, at(5))).toBe(true);
    expect(await h.port.complete(entry.id, 1, entry.claimToken, "final-message", at(6))).toBe(true);
    expect(await h.port.inspect(entry.id)).toMatchObject({ status: "DELIVERED", attemptCount: 1 });
  });

  it("resumes a committed handoff after its result is lost without letting the old owner's failure erase progress", async () => {
    const entry = await prepare();
    // Simulate lost command acknowledgement after a real commit, not a wire-level
    // PostgreSQL COMMIT failure. The worker cannot assume that rejection rolled back.
    await expect(h.port.yield(entry.id, entry.claimToken, at(4)).then(() => {
      throw new Error("handoff acknowledgement lost");
    })).rejects.toThrow("handoff acknowledgement lost");
    const [resumed] = await h.port.claim({ limit: 1, preferredKind: "analysis_completed", now: at(5), claimDurationMs: 30_000 });
    if (!resumed) { throw new Error("Expected resumed analysis"); }
    expect(resumed).toMatchObject({ id: entry.id, payload: analysisNotification(), attemptCount: 1,
      rendererVersion: 1, deliveryContext: context, deliveredPartNos: [0] });
    expect(resumed.claimToken).not.toBe(entry.claimToken);
    expect(await h.port.fail(entry.id, entry.claimToken, "delivery_uncertain", at(7), at(6))).toBe(false);
    expect(await h.port.begin(entry.id, 1, resumed.claimToken, at(7))).toBe(true);
    expect(await h.port.complete(entry.id, 1, entry.claimToken, "stale-message", at(8))).toBe(false);
    expect(await h.port.complete(entry.id, 1, resumed.claimToken, "resumed-message", at(9))).toBe(true);
    expect(await h.port.inspect(entry.id)).toMatchObject({ status: "DELIVERED", attemptCount: 1, parts: [
      { status: "DELIVERED", attemptCount: 1, deliveredMessageId: "already-sent" },
      { status: "DELIVERED", attemptCount: 1, deliveredMessageId: "resumed-message" }
    ] });
  });
});
