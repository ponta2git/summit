import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createResultNotificationDispatcher } from "../../src/notifications/delivery/composition.result.ts";
import type { DeliveryRuntime } from "../../src/notifications/delivery/runtime.ts";
import { RESULT_NOTIFICATION_CLAIM_BUDGET_BYTES, RESULT_NOTIFICATION_SEND_TIMEOUT_MS } from "../../src/config.ts";
import { notificationNow } from "../contracts/resultNotifications.ts";
import { deferred } from "../helpers/deferred.ts";
import { resultWorkerHarness } from "./resultNotifications.harness.ts";

describe("result dispatcher with SDK calls beyond the application timeout", () => {
  let runtime: DeliveryRuntime | undefined;
  const releases: Array<() => void> = [];
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(notificationNow); });
  afterEach(async () => {
    runtime?.stop(); releases.splice(0).forEach(release => release());
    await runtime?.drain(); vi.clearAllTimers(); vi.useRealTimers();
  });

  it("holds two owners for twenty minutes, does no retry polling, then resumes when actual I/O settles", async () => {
    const h = resultWorkerHarness();
    const ids = [await h.enqueue("a", "short"), await h.enqueue("b", "short"), await h.enqueue("c", "short")];
    const sent = deferred<{ id: string }>(); releases.push(() => sent.resolve({ id: "late" }));
    h.channel.send.mockImplementationOnce(() => sent.promise).mockImplementationOnce(() => sent.promise);
    runtime = createResultNotificationDispatcher(h); runtime.wake("startup");
    await vi.advanceTimersByTimeAsync(RESULT_NOTIFICATION_SEND_TIMEOUT_MS + 1);
    const claims = h.port.calls.filter(call => call.name === "claim").length;
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(h.channel.send).toHaveBeenCalledTimes(2);
    expect(h.port.calls.filter(call => call.name === "claim")).toHaveLength(claims);
    for (const id of ids.slice(0, 2)) { expect(await h.port.inspect(id!)).toMatchObject({ status: "PENDING", attemptCount: 1 }); }
    expect(await h.port.inspect(ids[2]!)).toMatchObject({ status: "PENDING", attemptCount: 0 });
    sent.resolve({ id: "late" }); await vi.advanceTimersByTimeAsync(1);
    await runtime.drain(); await vi.advanceTimersByTimeAsync(1);
    for (const id of ids) { expect(await h.port.inspect(id)).toMatchObject({ status: "DELIVERED" }); }
    expect(h.logger.info.mock.calls.filter(([value]) => value.event === "result_notification.io_late_success")).toHaveLength(2);
    // Existing nonce/CAS recovery still resends after settlement; no late success is persisted with an old token.
    expect(h.port.calls.filter(call => call.name === "complete")).toHaveLength(3);
  });

  it("retains an oversized historical reservation after timeout and drains actual I/O after stop", async () => {
    const h = resultWorkerHarness();
    await h.enqueue("a-large", "x".repeat(RESULT_NOTIFICATION_CLAIM_BUDGET_BYTES));
    const waiting = await h.enqueue("b-waiting", "short");
    const sent = deferred<{ id: string }>(); releases.push(() => sent.resolve({ id: "late" }));
    h.channel.send.mockImplementationOnce(() => sent.promise);
    runtime = createResultNotificationDispatcher(h); runtime.wake("startup");
    await vi.advanceTimersByTimeAsync(RESULT_NOTIFICATION_SEND_TIMEOUT_MS + 120_000);
    expect(h.channel.send).toHaveBeenCalledOnce();
    expect(await h.port.inspect(waiting)).toMatchObject({ status: "PENDING", attemptCount: 0 });
    runtime.stop(); let drained = false;
    const drain = runtime.drain().then(() => { drained = true; return undefined; });
    await vi.advanceTimersByTimeAsync(0); expect(drained).toBe(false);
    sent.resolve({ id: "late" }); await drain;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.channel.send).toHaveBeenCalledOnce();
    expect(h.port.calls.filter(call => call.name === "complete")).toHaveLength(0);
  });

  it("does not continue to send after a channel lookup succeeds past its timeout", async () => {
    const h = resultWorkerHarness(); await h.enqueue("lookup", "short");
    const channel = await h.client.channels.fetch("channel-1");
    const lookup = deferred<typeof channel>(); releases.push(() => lookup.resolve(channel));
    vi.mocked(h.client.channels.fetch).mockImplementationOnce(() => lookup.promise);
    runtime = createResultNotificationDispatcher(h); runtime.wake("startup");
    await vi.advanceTimersByTimeAsync(RESULT_NOTIFICATION_SEND_TIMEOUT_MS + 1);
    expect(h.channel.send).not.toHaveBeenCalled();
    runtime.stop(); lookup.resolve(channel); await runtime.drain();
    expect(h.channel.send).not.toHaveBeenCalled();
    expect(h.logger.info).toHaveBeenCalledWith(expect.objectContaining({ event: "result_notification.io_late_success", operation: "channel" }));
  });
});
