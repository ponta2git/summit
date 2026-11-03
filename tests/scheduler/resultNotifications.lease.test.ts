import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaimLease } from "../../src/time/lease.ts";
import { notificationNow } from "../contracts/resultNotifications.ts";
import { deferred } from "../helpers/deferred.ts";
import { resultWorkerHarness } from "./resultNotifications.harness.ts";

describe("result delivery across uncertain ownership", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(notificationNow); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it("persists an already-sent part while uncertain and resumes later parts with the same claim", async () => {
    const h = resultWorkerHarness(); const id = await h.enqueue(); const entry = await h.claim();
    const sending = deferred<void>(); const sent = deferred<{ id: string }>();
    h.channel.send.mockImplementationOnce(() => { sending.resolve(); return sent.promise; });
    const renew = h.port.renew;
    h.port.renew = vi.fn(renew).mockRejectedValueOnce(new Error("response lost"));
    const delivery = h.deliver(entry);
    try {
      await sending.promise; await vi.advanceTimersByTimeAsync(10_000);
      sent.resolve({ id: "first" }); await vi.advanceTimersByTimeAsync(0);
      expect((await h.port.inspect(id))?.parts[0]).toMatchObject({ status: "DELIVERED", deliveredMessageId: "first" });
      expect(h.channel.send).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1_000); await delivery;
      expect(await h.port.inspect(id)).toMatchObject({ status: "DELIVERED", attemptCount: 1 });
      expect(h.port.renew).toHaveBeenCalledTimes(2);
      expect(h.port.calls.filter(call => call.name === "claim")).toHaveLength(1);
      expect(h.logger.warn).toHaveBeenCalledExactlyOnceWith({ event: "result_notification.lease_uncertain", notificationId: id });
    } finally { sent.resolve({ id: "first" }); h.stop(); await delivery; }
  });

  it("rechecks ownership after channel acquisition and waits for an already-started renewal", async () => {
    const h = resultWorkerHarness(); const id = await h.enqueue("lookup-renewal", "short"); const entry = await h.claim();
    const channel = await h.client.channels.fetch("channel-1");
    const lookup = deferred<typeof channel>();
    vi.mocked(h.client.channels.fetch).mockImplementationOnce(() => lookup.promise);
    const reply = deferred<void>(); const originalRenew = h.port.renew;
    h.port.renew = vi.fn(async (notificationId, token, now, duration) => {
      const result = await originalRenew(notificationId, token, now, duration); await reply.promise; return result;
    });
    const begin = vi.spyOn(h.port, "begin"); const delivery = h.deliver(entry);
    try {
      await vi.advanceTimersByTimeAsync(20_000); lookup.resolve(channel); await vi.advanceTimersByTimeAsync(0);
      expect(begin).not.toHaveBeenCalled(); expect(h.channel.send).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5_000); reply.resolve(); await delivery;
      expect(begin).toHaveBeenCalledOnce(); expect(h.channel.send).toHaveBeenCalledOnce();
      expect(await h.port.inspect(id)).toMatchObject({ status: "DELIVERED", attemptCount: 1 });
    } finally { h.stop(); lookup.resolve(channel); reply.resolve(); await delivery; }
  });

  it("stops a new part while uncertain and retains the unresponsive renewal through shutdown", async () => {
    const h = resultWorkerHarness(); const id = await h.enqueue(); const entry = await h.claim();
    const sending = deferred<void>(); const sent = deferred<{ id: string }>();
    const renewal = deferred<ClaimLease | null>(); h.port.renew = vi.fn(() => renewal.promise);
    h.channel.send.mockImplementationOnce(() => { sending.resolve(); return sent.promise; });
    let drained = false;
    const delivery = h.deliver(entry).then(() => { drained = true; return undefined; });
    try {
      await sending.promise; await vi.advanceTimersByTimeAsync(20_000);
      sent.resolve({ id: "first" }); await vi.advanceTimersByTimeAsync(0);
      h.stop(); await vi.advanceTimersByTimeAsync(0);
      expect(h.channel.send).toHaveBeenCalledOnce(); expect(drained).toBe(false);
      expect((await h.port.inspect(id))?.parts[0]).toMatchObject({ status: "DELIVERED" });
      renewal.resolve(null); await delivery;
      expect(h.channel.send).toHaveBeenCalledOnce(); expect(h.port.renew).toHaveBeenCalledOnce();
    } finally { h.stop(); sent.resolve({ id: "first" }); renewal.resolve(null); await delivery; }
  });
});
