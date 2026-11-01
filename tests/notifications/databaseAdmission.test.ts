import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNotificationAdmission, type NotificationAdmissionRequest } from "../../src/db/notificationAdmission.ts";
import { NOTIFICATION_DB_MAX_PRODUCERS } from "../../src/config.ts";
import { InvariantViolationError, NotificationNotStartedError } from "../../src/errors/index.ts";
import { deferred } from "../helpers/deferred.ts";

const request = (key: string, family: "result" | "attendance" = "result",
  operation: NotificationAdmissionRequest["operation"] = "claim", remainingMs?: () => number): NotificationAdmissionRequest => ({
  key, family, operation, ...(remainingMs ? { remainingMs } : {})
});
const harness = () => {
  const logger = { warn: vi.fn() }; const admission = createNotificationAdmission({ logger });
  const calls: string[] = []; const releases: (() => void)[] = []; const work: Promise<unknown>[] = [];
  const hold = (input: NotificationAdmissionRequest) => {
    const release = deferred<void>(); releases.push(() => release.resolve());
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
    const h = harness();
    const a = h.hold(request("result-holder")); h.hold(request("result-waiter"));
    const third = h.hold(request("result-next")); const attendance = h.hold(request("attendance", "attendance", "renew"));
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(h.calls).toEqual(["result-holder", "result-waiter", "attendance"]);
      expect(h.admission.snapshot()).toMatchObject({ running: 3, result: 2, attendance: 1, waiting: 1 });
      attendance.release(); await attendance.pending;
      expect(h.calls).not.toContain("result-next");
      a.release(); await a.pending; await vi.advanceTimersByTimeAsync(0);
      expect(h.calls).toContain("result-next"); third.release(); await third.pending;
    } finally { await h.cleanup(); }
    expect(h.admission.snapshot()).toMatchObject({ running: 0, waiting: 0 });
  });

  it("makes same-family progress while one applied commit has not returned its response", async () => {
    const h = harness(); const committed = h.hold(request("committed-response-lost", "result", "finalize"));
    try {
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 4; i++) {
        expect(await h.admission.run(request("next"), async () => i)).toBe(i);
      }
      expect(h.admission.snapshot()).toMatchObject({ running: 1, result: 1, waiting: 0 });
      let drained = false; const draining = h.admission.drain().then(() => { drained = true; return undefined; });
      await vi.advanceTimersByTimeAsync(20 * 60_000); expect(drained).toBe(false);
      committed.release(); await draining;
    } finally { await h.cleanup(); }
  });

  it("expires only unstarted HTTP requests after five seconds and never cancels accepted work", async () => {
    const h = harness(); const accepted = h.hold(request("accepted", "result", "http")); h.hold(request("holder"));
    const waiting = h.hold(request("waiting", "result", "http")); const failed = waiting.pending.catch(error => error);
    try {
      await vi.advanceTimersByTimeAsync(5_000); expect(await failed).toMatchObject({ reason: "queue_timeout" });
      expect(h.calls).toEqual(["accepted", "holder"]);
      expect(h.admission.snapshot()).toMatchObject({ running: 2, waiting: 0 });
      accepted.release(); expect(await accepted.pending).toBe("accepted");
    } finally { await h.cleanup(); }
  });

  it("prioritizes the nearest confirmed deadline and gives a five-second-old ordinary request the next grant", async () => {
    const h = harness(); const first = h.hold(request("first")); const second = h.hold(request("second"));
    const ordinary = h.hold(request("ordinary"));
    const later = h.hold(request("later", "result", "finalize", () => 20_000));
    const urgent = h.hold(request("urgent", "result", "renew", () => 10_000));
    try {
      await vi.advanceTimersByTimeAsync(4_000); first.release(); await first.pending; await vi.advanceTimersByTimeAsync(0);
      expect(h.calls).toEqual(["first", "second", "urgent"]);
      await vi.advanceTimersByTimeAsync(1_001); second.release(); await second.pending; await vi.advanceTimersByTimeAsync(0);
      expect(h.calls).toEqual(["first", "second", "urgent", "ordinary"]);
      ordinary.release(); await ordinary.pending; await vi.advanceTimersByTimeAsync(0);
      expect(h.calls.at(-1)).toBe("later"); urgent.release(); later.release();
    } finally { await h.cleanup(); }
  });

  it("removes stopped new work while accepting renewal and known-send finalization during drain", async () => {
    const h = harness(); const first = h.hold(request("first")); h.hold(request("second"));
    await vi.advanceTimersByTimeAsync(0);
    const queued = ["claim", "begin", "maintenance", "http"] as const;
    const rejected = queued.map(operation => h.hold(request(operation, "result", operation)).pending.catch(error => error));
    h.admission.stop();
    expect(await Promise.all(rejected)).toEqual(queued.map(() => new NotificationNotStartedError("stopped")));
    const finalize = h.hold(request("finalize", "result", "finalize", () => -1));
    const renewal = h.hold(request("renew", "attendance", "renew", () => 10_000));
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(h.calls).toEqual(["first", "second", "renew"]);
      first.release(); await first.pending;
      await vi.advanceTimersByTimeAsync(0); expect(h.calls).toContain("finalize");
      finalize.release(); renewal.release();
    } finally { await h.cleanup(); }
  });

  it("gives only one aged ordinary grant before a waiting renewal among ten attendance owners", async () => {
    const h = harness();
    const owners = Array.from({ length: 10 }, (_, index) => h.hold(request(`owner-${index}`, "attendance", "begin")));
    try {
      await vi.advanceTimersByTimeAsync(10_000);
      const renew = h.hold(request("renew", "attendance", "renew", () => 30_000 - performance.now()));
      owners[0]!.release(); await owners[0]!.pending; await vi.advanceTimersByTimeAsync(0);
      expect(h.calls).toEqual(["owner-0", "owner-1", "owner-2"]);
      await vi.advanceTimersByTimeAsync(4_000);
      owners[1]!.release(); await owners[1]!.pending; await vi.advanceTimersByTimeAsync(0);
      expect(h.calls).toEqual(["owner-0", "owner-1", "owner-2", "renew"]);
      owners[2]!.release(); await owners[2]!.pending; await vi.advanceTimersByTimeAsync(0);
      renew.release(); await renew.pending; await vi.advanceTimersByTimeAsync(0);
      expect(h.calls.slice(2, 6)).toEqual(["owner-2", "renew", "owner-3", "owner-4"]);
    } finally { await h.cleanup(); }
  });

  it("expires a queued begin/renew without a connection and still attempts an expired known-send finalize", async () => {
    const h = harness(); const first = h.hold(request("first")); h.hold(request("second"));
    let deadline = 1_000;
    const begin = h.hold(request("begin", "result", "begin", () => deadline - performance.now()));
    const renew = h.hold(request("renew", "result", "renew", () => 1_000 - performance.now()));
    const expired = renew.pending.catch(error => error);
    const finalize = h.hold(request("finalize", "result", "finalize", () => -1));
    try {
      await vi.advanceTimersByTimeAsync(500); deadline = 3_000;
      await vi.advanceTimersByTimeAsync(500);
      expect(await expired).toMatchObject({ reason: "expired" }); expect(h.calls).not.toContain("renew");
      expect(h.admission.snapshot().waiting).toBe(2);
      const beginExpired = begin.pending.catch(error => error);
      await vi.advanceTimersByTimeAsync(2_000); expect(await beginExpired).toMatchObject({ reason: "expired" });
      first.release(); await first.pending; await vi.advanceTimersByTimeAsync(0);
      expect(h.calls).toContain("finalize"); expect(h.calls).not.toContain("begin"); finalize.release();
    } finally { await h.cleanup(); }
  });

  it("bounds producers and diagnostics during a twenty-minute outage, including a throwing logger", async () => {
    const h = harness();
    h.logger.warn.mockImplementation(() => { throw new Error("logging unavailable"); });
    try {
      for (let i = 0; i < NOTIFICATION_DB_MAX_PRODUCERS; i++) { h.hold(request(`job-${i}`, i === 2 ? "attendance" : "result")); }
      await expect(h.admission.run(request("overflow"), async () => 1)).rejects.toBeInstanceOf(InvariantViolationError);
      await expect(h.admission.run(request("job-0"), async () => 1)).rejects.toBeInstanceOf(InvariantViolationError);
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      expect(h.calls).toHaveLength(3); expect(h.admission.snapshot().waiting).toBe(NOTIFICATION_DB_MAX_PRODUCERS - 3);
      expect(h.logger.warn).toHaveBeenCalledTimes(19);
      expect(h.logger.warn.mock.calls.at(-1)?.[0]).toMatchObject({ event: "notification.database_pending", investigate: true, running: 3 });
    } finally { await h.cleanup(); }
    expect(h.admission.snapshot()).toMatchObject({ running: 0, waiting: 0 });
  });
});
