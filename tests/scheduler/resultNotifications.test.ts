import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createResultNotificationDispatcher, type ResultNotificationDispatcher } from "../../src/scheduler/resultNotifications.ts";
import { resultNotificationNonce } from "../../src/scheduler/resultNotifications.delivery.ts";
import { RESULT_NOTIFICATION_CONCURRENCY, RESULT_NOTIFICATION_RECOVERY_BACKOFF_MS, SCHEDULER_WAKE_DEBOUNCE_MS } from "../../src/config.ts";
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

  it("continues filling free slots while a long delivery is pending and becomes idle after completion", async () => {
    const h = resultWorkerHarness(); const longId = await h.enqueue("a-long", "Long summary");
    const shortIds = [];
    for (let i = 0; i < RESULT_NOTIFICATION_CONCURRENCY + 1; i += 1) { shortIds.push(await h.enqueue(`short-${i}`, "Short summary")); }
    const release = deferred<{ id: string }>(); releases.push(() => release.resolve({ id: "long" }));
    let inFlight = 0; let peak = 0;
    h.channel.send.mockImplementation(async body => {
      inFlight += 1; peak = Math.max(peak, inFlight);
      try { return body.nonce === resultNotificationNonce(longId, 0) ? await release.promise : { id: String(body.nonce) }; }
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

  it("uses bounded DB recovery attempts, then recovers on a supervisor wake", async () => {
    const h = resultWorkerHarness(); const id = await h.enqueue("recover", "Short summary");
    const claim = h.port.claim; const failed = vi.fn(async () => { throw new Error("private DB value"); }); h.port.claim = failed;
    dispatcher = createResultNotificationDispatcher(h); dispatcher.wake("receipt"); await tick();
    for (const delay of RESULT_NOTIFICATION_RECOVERY_BACKOFF_MS) { await vi.advanceTimersByTimeAsync(delay); }
    expect(failed).toHaveBeenCalledTimes(RESULT_NOTIFICATION_RECOVERY_BACKOFF_MS.length + 1);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(failed).toHaveBeenCalledTimes(RESULT_NOTIFICATION_RECOVERY_BACKOFF_MS.length + 1);
    h.port.claim = claim; dispatcher.wake("supervisor"); await tick(); await tick();
    expect((await h.port.inspect(id))?.status).toBe("DELIVERED");
    expect(JSON.stringify(h.logger.warn.mock.calls)).not.toContain("private DB value");
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
