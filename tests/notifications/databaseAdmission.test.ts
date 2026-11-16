import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNotificationAdmission, type NotificationAdmissionRequest } from "../../src/db/notificationAdmission.ts";
import { NOTIFICATION_DB_MAX_PRODUCERS } from "../../src/config.ts";
import { InvariantViolationError, NotificationNotStartedError } from "../../src/errors/index.ts";
import { deferredSignal } from "../helpers/deferred.ts";

const request = (key: string, family: "result" | "attendance" = "result",
  operation: NotificationAdmissionRequest["operation"] = "claim", remainingMs?: () => number): NotificationAdmissionRequest => ({
  key, family, operation, ...(remainingMs ? { remainingMs } : {})
});
const createHarness = (monotonicNow?: () => number) => {
  const logger = { warn: vi.fn() }; const admission = createNotificationAdmission({ logger,
    ...(monotonicNow ? { monotonicNow } : {}) });
  const calls: string[] = []; const releases: (() => void)[] = []; const work: Promise<unknown>[] = [];
  const hold = (input: NotificationAdmissionRequest) => {
    const release = deferredSignal(); releases.push(() => release.resolve());
    const pending = admission.run(input, async () => { calls.push(String(input.key)); await release.promise; return input.key; });
    work.push(pending.catch(() => undefined));
    return { pending, release: () => release.resolve() };
  };
  return { admission, logger, calls, hold, cleanup: async () => { admission.stop(); releases.forEach(release => release()); await Promise.all(work); await admission.drain(); } };
};

describe("notification database admission", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it("retains actual operations at family two/global three and reserves progress for the other family", async () => {
    const harness = createHarness();
    const resultHolder = harness.hold(request("result-holder")); harness.hold(request("result-waiter"));
    const third = harness.hold(request("result-next")); const attendance = harness.hold(request("attendance", "attendance", "renew"));
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.calls).toEqual(["result-holder", "result-waiter", "attendance"]);
      expect(harness.admission.snapshot()).toMatchObject({ running: 3, result: 2, attendance: 1, waiting: 1 });
      attendance.release(); await attendance.pending;
      expect(harness.calls).not.toContain("result-next");
      resultHolder.release(); await resultHolder.pending; await vi.advanceTimersByTimeAsync(0);
      expect(harness.calls).toContain("result-next"); third.release(); await third.pending;
    } finally { await harness.cleanup(); }
    expect(harness.admission.snapshot()).toMatchObject({ running: 0, waiting: 0 });
  });

  it("makes same-family progress while one applied commit has not returned its response", async () => {
    const harness = createHarness(); const committed = harness.hold(request("committed-response-lost", "result", "finalize"));
    try {
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 4; i++) {
        expect(await harness.admission.run(request("next"), async () => i)).toBe(i);
      }
      expect(harness.admission.snapshot()).toMatchObject({ running: 1, result: 1, waiting: 0 });
      let drained = false; const draining = harness.admission.drain().then(() => { drained = true; return undefined; });
      await vi.advanceTimersByTimeAsync(20 * 60_000); expect(drained).toBe(false);
      committed.release(); await draining;
    } finally { await harness.cleanup(); }
  });

  it("expires only unstarted HTTP requests after five seconds and never cancels accepted work", async () => {
    const harness = createHarness(); const accepted = harness.hold(request("accepted", "result", "http")); harness.hold(request("holder"));
    const waiting = harness.hold(request("waiting", "result", "http")); const failed = waiting.pending.catch(error => error);
    try {
      await vi.advanceTimersByTimeAsync(5_000); expect(await failed).toMatchObject({ reason: "queue_timeout" });
      expect(harness.calls).toEqual(["accepted", "holder"]);
      expect(harness.admission.snapshot()).toMatchObject({ running: 2, waiting: 0 });
      accepted.release(); expect(await accepted.pending).toBe("accepted");
    } finally { await harness.cleanup(); }
  });

  it("rejects an expired HTTP waiter before a holder settlement can bypass its delayed timer", async () => {
    let now = 0;
    const harness = createHarness(() => now); const first = harness.hold(request("first")); harness.hold(request("second"));
    const waiting = harness.hold(request("waiting", "result", "http")); const failed = waiting.pending.catch(error => error);
    try {
      await vi.advanceTimersByTimeAsync(0);
      // A synchronous pause advances the real deadline before timer callbacks can execute.
      now = 5_001; first.release(); await first.pending;
      expect(harness.calls).toEqual(["first", "second"]);
      expect(await failed).toMatchObject({ reason: "queue_timeout" });
      expect(harness.admission.snapshot()).toMatchObject({ running: 1, waiting: 0 });
    } finally { await harness.cleanup(); }
  });

  it("prioritizes the nearest confirmed deadline and gives a five-second-old ordinary request the next grant", async () => {
    const harness = createHarness(); const first = harness.hold(request("first")); const second = harness.hold(request("second"));
    const ordinary = harness.hold(request("ordinary"));
    const later = harness.hold(request("later", "result", "finalize", () => 20_000));
    const urgent = harness.hold(request("urgent", "result", "renew", () => 10_000));
    try {
      await vi.advanceTimersByTimeAsync(4_000); first.release(); await first.pending; await vi.advanceTimersByTimeAsync(0);
      expect(harness.calls).toEqual(["first", "second", "urgent"]);
      await vi.advanceTimersByTimeAsync(1_001); second.release(); await second.pending; await vi.advanceTimersByTimeAsync(0);
      expect(harness.calls).toEqual(["first", "second", "urgent", "ordinary"]);
      ordinary.release(); await ordinary.pending; await vi.advanceTimersByTimeAsync(0);
      expect(harness.calls.at(-1)).toBe("later"); urgent.release(); later.release();
    } finally { await harness.cleanup(); }
  });

  it("removes stopped new work while accepting renewal and known-send finalization during drain", async () => {
    const harness = createHarness(); const first = harness.hold(request("first")); harness.hold(request("second"));
    await vi.advanceTimersByTimeAsync(0);
    const queued = ["claim", "begin", "maintenance", "http"] as const;
    const rejected = queued.map(operation => harness.hold(request(operation, "result", operation)).pending.catch(error => error));
    harness.admission.stop();
    expect(await Promise.all(rejected)).toEqual(queued.map(() => new NotificationNotStartedError("stopped")));
    const finalize = harness.hold(request("finalize", "result", "finalize", () => -1));
    const renewal = harness.hold(request("renew", "attendance", "renew", () => 10_000));
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.calls).toEqual(["first", "second", "renew"]);
      first.release(); await first.pending;
      await vi.advanceTimersByTimeAsync(0); expect(harness.calls).toContain("finalize");
      finalize.release(); renewal.release();
    } finally { await harness.cleanup(); }
  });

  it("gives only one aged ordinary grant before a waiting renewal among ten attendance owners", async () => {
    const harness = createHarness();
    const owners = Array.from({ length: 10 }, (_, index) => harness.hold(request(`owner-${index}`, "attendance", "begin")));
    try {
      await vi.advanceTimersByTimeAsync(10_000);
      const renew = harness.hold(request("renew", "attendance", "renew", () => 30_000 - performance.now()));
      owners[0]!.release(); await owners[0]!.pending; await vi.advanceTimersByTimeAsync(0);
      expect(harness.calls).toEqual(["owner-0", "owner-1", "owner-2"]);
      await vi.advanceTimersByTimeAsync(4_000);
      owners[1]!.release(); await owners[1]!.pending; await vi.advanceTimersByTimeAsync(0);
      expect(harness.calls).toEqual(["owner-0", "owner-1", "owner-2", "renew"]);
      owners[2]!.release(); await owners[2]!.pending; await vi.advanceTimersByTimeAsync(0);
      renew.release(); await renew.pending; await vi.advanceTimersByTimeAsync(0);
      expect(harness.calls.slice(2, 6)).toEqual(["owner-2", "renew", "owner-3", "owner-4"]);
    } finally { await harness.cleanup(); }
  });

  it("expires a queued begin/renew without a connection and still attempts an expired known-send finalize", async () => {
    const harness = createHarness(); const first = harness.hold(request("first")); harness.hold(request("second"));
    let deadline = 1_000;
    const begin = harness.hold(request("begin", "result", "begin", () => deadline - performance.now()));
    const renew = harness.hold(request("renew", "result", "renew", () => 1_000 - performance.now()));
    const expired = renew.pending.catch(error => error);
    const finalize = harness.hold(request("finalize", "result", "finalize", () => -1));
    try {
      await vi.advanceTimersByTimeAsync(500); deadline = 3_000;
      await vi.advanceTimersByTimeAsync(500);
      expect(await expired).toMatchObject({ reason: "expired" }); expect(harness.calls).not.toContain("renew");
      expect(harness.admission.snapshot().waiting).toBe(2);
      const beginExpired = begin.pending.catch(error => error);
      await vi.advanceTimersByTimeAsync(2_000); expect(await beginExpired).toMatchObject({ reason: "expired" });
      first.release(); await first.pending; await vi.advanceTimersByTimeAsync(0);
      expect(harness.calls).toContain("finalize"); expect(harness.calls).not.toContain("begin"); finalize.release();
    } finally { await harness.cleanup(); }
  });

  it("bounds producers and diagnostics during a twenty-minute outage, including a throwing logger", async () => {
    const harness = createHarness();
    harness.logger.warn.mockImplementation(() => { throw new Error("logging unavailable"); });
    try {
      for (let i = 0; i < NOTIFICATION_DB_MAX_PRODUCERS; i++) { harness.hold(request(`job-${i}`, i === 2 ? "attendance" : "result")); }
      await expect(harness.admission.run(request("overflow"), async () => 1)).rejects.toBeInstanceOf(InvariantViolationError);
      await expect(harness.admission.run(request("job-0"), async () => 1)).rejects.toBeInstanceOf(InvariantViolationError);
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      expect(harness.calls).toHaveLength(3); expect(harness.admission.snapshot().waiting).toBe(NOTIFICATION_DB_MAX_PRODUCERS - 3);
      expect(harness.logger.warn).toHaveBeenCalledTimes(19);
      expect(harness.logger.warn.mock.calls.at(-1)?.[0]).toMatchObject({ event: "notification.database_pending", investigate: true, running: 3 });
    } finally { await harness.cleanup(); }
    expect(harness.admission.snapshot()).toMatchObject({ running: 0, waiting: 0 });
  });
});
