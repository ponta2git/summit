import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaimLease } from "../../src/time/lease.ts";
import { notificationNow } from "../contracts/resultNotifications.ts";
import { deferred, deferredSignal } from "../helpers/deferred.ts";
import { resultWorkerHarness } from "./resultNotifications.harness.ts";

describe("result delivery across uncertain ownership", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(notificationNow); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it("persists an already-sent part while uncertain and resumes later parts with the same claim", async () => {
    const harness = resultWorkerHarness(); const id = await harness.enqueue(); const entry = await harness.claim();
    const sending = deferredSignal(); const sent = deferred<{ id: string }>();
    harness.channel.send.mockImplementationOnce(() => { sending.resolve(); return sent.promise; });
    const renew = harness.port.renew;
    harness.port.renew = vi.fn(renew).mockRejectedValueOnce(new Error("response lost"));
    const delivery = harness.deliver(entry);
    try {
      await sending.promise; await vi.advanceTimersByTimeAsync(10_000);
      sent.resolve({ id: "first" }); await vi.advanceTimersByTimeAsync(0);
      expect((await harness.port.inspect(id))?.parts[0]).toMatchObject({ status: "DELIVERED", deliveredMessageId: "first" });
      expect(harness.channel.send).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1_000); await delivery;
      expect(await harness.port.inspect(id)).toMatchObject({ status: "DELIVERED", attemptCount: 1 });
      expect(harness.port.renew).toHaveBeenCalledTimes(2);
      expect(harness.port.calls.filter(call => call.name === "claim")).toHaveLength(1);
      expect(harness.logger.warn).toHaveBeenCalledExactlyOnceWith({ event: "result_notification.lease_uncertain", notificationId: id });
    } finally { sent.resolve({ id: "first" }); harness.stop(); await delivery; }
  });

  it("rechecks ownership after channel acquisition and waits for an already-started renewal", async () => {
    const harness = resultWorkerHarness(); const id = await harness.enqueue("lookup-renewal", "short"); const entry = await harness.claim();
    const channel = await harness.client.channels.fetch("channel-1");
    const lookup = deferred<typeof channel>();
    vi.mocked(harness.client.channels.fetch).mockImplementationOnce(() => lookup.promise);
    const reply = deferredSignal(); const originalRenew = harness.port.renew;
    harness.port.renew = vi.fn(async (notificationId, token, now, duration) => {
      const result = await originalRenew(notificationId, token, now, duration); await reply.promise; return result;
    });
    const begin = vi.spyOn(harness.port, "begin"); const delivery = harness.deliver(entry);
    try {
      await vi.advanceTimersByTimeAsync(20_000); lookup.resolve(channel); await vi.advanceTimersByTimeAsync(0);
      expect(begin).not.toHaveBeenCalled(); expect(harness.channel.send).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5_000); reply.resolve(); await delivery;
      expect(begin).toHaveBeenCalledOnce(); expect(harness.channel.send).toHaveBeenCalledOnce();
      expect(await harness.port.inspect(id)).toMatchObject({ status: "DELIVERED", attemptCount: 1 });
    } finally { harness.stop(); lookup.resolve(channel); reply.resolve(); await delivery; }
  });

  it("stops a new part while uncertain and retains the unresponsive renewal through shutdown", async () => {
    const harness = resultWorkerHarness(); const id = await harness.enqueue(); const entry = await harness.claim();
    const sending = deferredSignal(); const sent = deferred<{ id: string }>();
    const renewal = deferred<ClaimLease | null>(); harness.port.renew = vi.fn(() => renewal.promise);
    harness.channel.send.mockImplementationOnce(() => { sending.resolve(); return sent.promise; });
    let drained = false;
    const delivery = harness.deliver(entry).then(() => { drained = true; return undefined; });
    try {
      await sending.promise; await vi.advanceTimersByTimeAsync(20_000);
      sent.resolve({ id: "first" }); await vi.advanceTimersByTimeAsync(0);
      harness.stop(); await vi.advanceTimersByTimeAsync(0);
      expect(harness.channel.send).toHaveBeenCalledOnce(); expect(drained).toBe(false);
      expect((await harness.port.inspect(id))?.parts[0]).toMatchObject({ status: "DELIVERED" });
      renewal.resolve(null); await delivery;
      expect(harness.channel.send).toHaveBeenCalledOnce(); expect(harness.port.renew).toHaveBeenCalledOnce();
    } finally { harness.stop(); sent.resolve({ id: "first" }); renewal.resolve(null); await delivery; }
  });
});
