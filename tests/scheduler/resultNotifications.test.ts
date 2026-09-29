import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createResultNotificationDispatcher, type ResultNotificationDispatcher } from "../../src/scheduler/resultNotifications.ts";
import { notificationNonce } from "../../src/scheduler/deliveryNonce.ts";
import { RESULT_NOTIFICATION_CLAIM_BUDGET_BYTES, RESULT_NOTIFICATION_CONCURRENCY, RESULT_NOTIFICATION_RECOVERY_BACKOFF_MS, SCHEDULER_WAKE_DEBOUNCE_MS } from "../../src/config.ts";
import { notificationNow } from "../contracts/resultNotifications.ts";
import { deferred } from "../helpers/deferred.ts";
import { resultWorkerHarness } from "./resultNotifications.harness.ts";

describe("result notification dispatcher", () => {
  let dispatcher: ResultNotificationDispatcher | undefined;
  const releases: Array<() => void> = [];
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(notificationNow); });
  afterEach(async () => {
    dispatcher?.stop(); for (const release of releases.splice(0)) { release(); }
    await dispatcher?.drain(); vi.clearAllTimers(); vi.useRealTimers();
  });
  const tick = () => vi.advanceTimersByTimeAsync(SCHEDULER_WAKE_DEBOUNCE_MS);

  it("starts delivery by the first wake deadline while receipts keep arriving", async () => {
    const h = resultWorkerHarness(); const id = await h.enqueue("continuous-receipts", "Short summary");
    dispatcher = createResultNotificationDispatcher(h); dispatcher.wake("first_receipt");
    for (let elapsed = 50; elapsed < SCHEDULER_WAKE_DEBOUNCE_MS; elapsed += 50) {
      await vi.advanceTimersByTimeAsync(50);
      dispatcher.wake("another_receipt");
    }
    expect(h.channel.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    expect((await h.port.inspect(id))?.status).toBe("DELIVERED");
    expect(h.channel.send).toHaveBeenCalledOnce();
  });

  it("continues filling free slots while a long delivery is pending and becomes idle after completion", async () => {
    const h = resultWorkerHarness(); const longId = await h.enqueue("a-long", "Long summary");
    const shortIds = [];
    for (let i = 0; i < RESULT_NOTIFICATION_CONCURRENCY + 1; i += 1) { shortIds.push(await h.enqueue(`short-${i}`, "Short summary")); }
    const release = deferred<{ id: string }>(); releases.push(() => release.resolve({ id: "long" }));
    let inFlight = 0; let peak = 0;
    h.channel.send.mockImplementation(async body => {
      inFlight += 1; peak = Math.max(peak, inFlight);
      try { return body.nonce === notificationNonce(longId, 0) ? await release.promise : { id: String(body.nonce) }; }
      finally { inFlight -= 1; }
    });
    dispatcher = createResultNotificationDispatcher(h); dispatcher.wake("receipt");
    await tick(); await tick(); await tick();
    expect(peak).toBeLessThanOrEqual(RESULT_NOTIFICATION_CONCURRENCY);
    expect((await h.port.inspect(longId))?.status).toBe("IN_FLIGHT");
    for (const id of shortIds) { expect((await h.port.inspect(id))?.status).toBe("DELIVERED"); }
    release.resolve({ id: "long" }); await dispatcher.drain(); await tick();
    const queries = h.port.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.port.calls).toHaveLength(queries);
  });

  it("retains a wake that arrives while the final idle query is in flight", async () => {
    const h = resultWorkerHarness(); const entered = deferred<void>(); const release = deferred<void>();
    releases.push(() => release.resolve()); const next = h.port.getNextDispatchAt; let pause = true;
    h.port.getNextDispatchAt = async ids => { const value = await next(ids); if (pause) { pause = false; entered.resolve(); await release.promise; } return value; };
    dispatcher = createResultNotificationDispatcher(h); dispatcher.wake("startup");
    await tick(); await entered.promise;
    const id = await h.enqueue("late", "Short summary"); dispatcher.wake("receipt");
    release.resolve(); await Promise.resolve(); await tick(); await tick();
    expect((await h.port.inspect(id))?.status).toBe("DELIVERED");
  });

  it("waits for retained bytes to be released before filling an otherwise free delivery slot", async () => {
    const h = resultWorkerHarness();
    const first = await h.enqueue("a-retained", "x".repeat(300 * 1_024));
    const next = await h.enqueue("b-waiting", "x".repeat(250 * 1_024));
    const release = deferred<{ id: string }>(); releases.push(() => release.resolve({ id: "released" }));
    h.channel.send.mockImplementation(async body => body.nonce === notificationNonce(first, 0) ? release.promise : { id: String(body.nonce) });
    const claim = h.port.claim; const reservations: Array<{ available: number | undefined; total: number }> = [];
    h.port.claim = async options => {
      const entries = await claim(options);
      reservations.push({ available: options.payloadBudgetBytes, total: entries.reduce((sum, entry) => sum + entry.payloadBytes, 0) });
      return entries;
    };
    dispatcher = createResultNotificationDispatcher(h); dispatcher.wake("startup"); await tick();
    expect(await h.port.inspect(first)).toMatchObject({ status: "IN_FLIGHT", attemptCount: 1 });
    expect(await h.port.inspect(next)).toMatchObject({ status: "PENDING", attemptCount: 0 });
    dispatcher.wake("receipt"); await tick();
    expect(reservations).toHaveLength(2);
    expect(reservations[0]?.total).toBeGreaterThan(300 * 1_024);
    expect(reservations[1]).toEqual({ available: RESULT_NOTIFICATION_CLAIM_BUDGET_BYTES - (reservations[0]?.total ?? 0), total: 0 });
    const claimCount = h.port.calls.filter(call => call.name === "claim").length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.port.calls.filter(call => call.name === "claim")).toHaveLength(claimCount);
    release.resolve({ id: "released" }); await dispatcher.drain(); await tick();
    expect(await h.port.inspect(first)).toMatchObject({ status: "DELIVERED" });
    expect(await h.port.inspect(next)).toMatchObject({ status: "DELIVERED" });
  });

  it("delivers one oversized historical payload alone and resumes normal work after it finishes", async () => {
    const h = resultWorkerHarness();
    const legacy = await h.enqueue("a-legacy", "x".repeat(RESULT_NOTIFICATION_CLAIM_BUDGET_BYTES));
    const normal = await h.enqueue("b-normal", "Short summary");
    const release = deferred<{ id: string }>(); releases.push(() => release.resolve({ id: "legacy-finished" }));
    h.channel.send.mockImplementation(async body => body.nonce === notificationNonce(legacy, 0) ? release.promise : { id: String(body.nonce) });
    dispatcher = createResultNotificationDispatcher(h); dispatcher.wake("startup"); await tick();
    expect(await h.port.inspect(legacy)).toMatchObject({ status: "IN_FLIGHT", attemptCount: 1 });
    expect(await h.port.inspect(normal)).toMatchObject({ status: "PENDING", attemptCount: 0 });
    const claimCount = h.port.calls.filter(call => call.name === "claim").length;
    dispatcher.wake("another_receipt"); await tick();
    expect(h.port.calls.filter(call => call.name === "claim")).toHaveLength(claimCount);
    release.resolve({ id: "legacy-finished" }); await dispatcher.drain(); await tick();
    expect(await h.port.inspect(legacy)).toMatchObject({ status: "DELIVERED" });
    expect(await h.port.inspect(normal)).toMatchObject({ status: "DELIVERED" });
  });

  it("lets active work drain instead of letting small arrivals starve an older oversized payload", async () => {
    const h = resultWorkerHarness();
    const active = await h.enqueue("a-active", "Short summary");
    const activeRelease = deferred<{ id: string }>(); const legacyRelease = deferred<{ id: string }>();
    releases.push(() => activeRelease.resolve({ id: "active-finished" }), () => legacyRelease.resolve({ id: "legacy-finished" }));
    const legacyId = "result:analysis_completed:b-legacy";
    h.channel.send.mockImplementation(async body => {
      if (body.nonce === notificationNonce(active, 0)) { return activeRelease.promise; }
      if (body.nonce === notificationNonce(legacyId, 0)) { return legacyRelease.promise; }
      return { id: String(body.nonce) };
    });
    dispatcher = createResultNotificationDispatcher(h); dispatcher.wake("startup"); await tick();
    await h.enqueue("b-legacy", "x".repeat(RESULT_NOTIFICATION_CLAIM_BUDGET_BYTES));
    const firstSmall = await h.enqueue("c-small", "Short summary");
    dispatcher.wake("receipt"); await tick();
    const secondSmall = await h.enqueue("d-small", "Short summary");
    dispatcher.wake("receipt"); await tick();
    for (const id of [legacyId, firstSmall, secondSmall]) {
      expect(await h.port.inspect(id)).toMatchObject({ status: "PENDING", attemptCount: 0 });
    }
    activeRelease.resolve({ id: "active-finished" }); await dispatcher.drain(); await tick();
    expect(await h.port.inspect(legacyId)).toMatchObject({ status: "IN_FLIGHT", attemptCount: 1 });
    for (const id of [firstSmall, secondSmall]) { expect(await h.port.inspect(id)).toMatchObject({ status: "PENDING", attemptCount: 0 }); }
    legacyRelease.resolve({ id: "legacy-finished" }); await dispatcher.drain(); await tick();
    for (const id of [legacyId, firstSmall, secondSmall]) { expect(await h.port.inspect(id)).toMatchObject({ status: "DELIVERED" }); }
  });

  it("releases the byte reservation after a terminal delivery failure", async () => {
    const h = resultWorkerHarness();
    const failed = await h.enqueue("a-failed", "x".repeat(300 * 1_024));
    const waiting = await h.enqueue("b-waiting", "x".repeat(250 * 1_024));
    h.channel.send.mockRejectedValueOnce({ status: 403 });
    dispatcher = createResultNotificationDispatcher(h); dispatcher.wake("startup"); await tick(); await tick();
    expect(await h.port.inspect(failed)).toMatchObject({ status: "FAILED", lastError: "delivery_failed" });
    expect(await h.port.inspect(waiting)).toMatchObject({ status: "DELIVERED", attemptCount: 1 });
  });

  it("drains a claim that settles after stop without starting delivery and leaves lease recovery intact", async () => {
    const h = resultWorkerHarness(); const id = await h.enqueue("late-claim", "Short summary");
    const entered = deferred<void>(); const release = deferred<void>(); releases.push(() => release.resolve());
    const claim = h.port.claim;
    h.port.claim = async options => { const result = await claim(options); entered.resolve(); await release.promise; return result; };
    dispatcher = createResultNotificationDispatcher(h); dispatcher.wake("startup"); await tick(); await entered.promise;
    dispatcher.stop(); release.resolve(); await dispatcher.drain();
    expect(h.channel.send).not.toHaveBeenCalled();
    expect(await h.port.inspect(id)).toMatchObject({ status: "IN_FLIGHT", attemptCount: 1 });
    const reclaimed = await claim({ limit: 1, now: new Date(notificationNow.getTime() + 300_000), claimDurationMs: 30_000 });
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]).toMatchObject({ id, attemptCount: 2 });
    expect(reclaimed[0]?.payloadBytes).toBeGreaterThan(0);
  });

  it.each(["claim", "getNextDispatchAt"] as const)("bounds consecutive %s failures, then recovers on a supervisor wake", async operation => {
    const h = resultWorkerHarness();
    const original = h.port[operation];
    const failed = vi.fn(async () => { throw new Error("private DB value"); }); h.port[operation] = failed;
    dispatcher = createResultNotificationDispatcher(h); dispatcher.wake("receipt"); await tick();
    for (const delay of RESULT_NOTIFICATION_RECOVERY_BACKOFF_MS) { await vi.advanceTimersByTimeAsync(delay); }
    expect(failed).toHaveBeenCalledTimes(RESULT_NOTIFICATION_RECOVERY_BACKOFF_MS.length + 1);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(failed).toHaveBeenCalledTimes(RESULT_NOTIFICATION_RECOVERY_BACKOFF_MS.length + 1);
    Object.assign(h.port, { [operation]: original });
    const id = await h.enqueue("recover", "Short summary");
    dispatcher.wake("supervisor"); await tick(); await tick();
    expect((await h.port.inspect(id))?.status).toBe("DELIVERED");
    expect(JSON.stringify(h.logger.warn.mock.calls)).not.toContain("private DB value");
    // A successful cycle restores the complete recovery budget for a later outage.
    h.port[operation] = failed;
    dispatcher.wake("supervisor"); await tick();
    for (const delay of RESULT_NOTIFICATION_RECOVERY_BACKOFF_MS) { await vi.advanceTimersByTimeAsync(delay); }
    expect(failed).toHaveBeenCalledTimes(2 * (RESULT_NOTIFICATION_RECOVERY_BACKOFF_MS.length + 1));
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(failed).toHaveBeenCalledTimes(2 * (RESULT_NOTIFICATION_RECOVERY_BACKOFF_MS.length + 1));
  });

  it("schedules a future retry once and does no DB work while waiting", async () => {
    const h = resultWorkerHarness(); const id = await h.enqueue("backoff", "Short summary"); const claim = await h.claim();
    await h.port.fail(id, claim.claimToken, "discord_unavailable", new Date(notificationNow.getTime() + 60_000), notificationNow);
    dispatcher = createResultNotificationDispatcher(h); dispatcher.wake("startup"); await tick();
    const queries = h.port.calls.length; await vi.advanceTimersByTimeAsync(59_000);
    expect(h.port.calls).toHaveLength(queries);
    await vi.advanceTimersByTimeAsync(1_000); await tick();
    expect((await h.port.inspect(id))?.status).toBe("DELIVERED");
  });
});
