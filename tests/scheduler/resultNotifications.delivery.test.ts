import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageFlags } from "discord.js";
import { deliverResultNotification, resultNotificationNonce } from "../../src/scheduler/resultNotifications.delivery.ts";
import { RESULT_NOTIFICATION_SEND_TIMEOUT_MS } from "../../src/config.ts";
import { notificationNow } from "../contracts/resultNotifications.ts";
import { deferred } from "../helpers/deferred.ts";
import { resultWorkerHarness } from "./resultNotifications.harness.ts";

describe("result notification delivery", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(notificationNow); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it("reuses each part's nonce and persisted context, skips delivered parts, and disables mentions", async () => {
    const h = resultWorkerHarness(); const id = await h.enqueue(); const entry = await h.claim();
    h.channel.send.mockResolvedValueOnce({ id: "first" }).mockRejectedValueOnce(new Error("Response missing"));
    await h.deliver(entry);
    expect(await h.port.inspect(id)).toMatchObject({ status: "PENDING", lastError: "delivery_uncertain" });
    const firstPayload = h.channel.send.mock.calls[0]?.[0];
    const uncertainPayload = h.channel.send.mock.calls[1]?.[0];
    expect(firstPayload).toMatchObject({ nonce: resultNotificationNonce(id, 0), enforceNonce: true,
      allowedMentions: { parse: [], users: [], roles: [], repliedUser: false }, flags: MessageFlags.SuppressEmbeds });
    await vi.advanceTimersByTimeAsync(1_000);
    const retry = await h.claim();
    await deliverResultNotification({ ...h, context: { channelId: "changed", webOrigin: "https://changed.example.com" } }, retry);
    expect(h.channel.send.mock.calls[2]?.[0]).toEqual(uncertainPayload);
    expect(h.channel.send.mock.calls.filter(([body]) => body.nonce === firstPayload?.nonce)).toHaveLength(1);
    expect(h.client.channels.fetch).toHaveBeenLastCalledWith("channel-1");
    expect(await h.port.inspect(id)).toMatchObject({ status: "DELIVERED" });
    expect(String(firstPayload?.nonce).length).toBeLessThanOrEqual(25);
    expect(resultNotificationNonce(id, 0)).not.toBe(resultNotificationNonce(id, 1));
  });

  it("records an already-started send after OFF and stops all later parts", async () => {
    const h = resultWorkerHarness(); const id = await h.enqueue(); const entry = await h.claim();
    const sending = deferred<void>(); const sent = deferred<{ id: string }>();
    h.channel.send.mockImplementationOnce(() => { sending.resolve(); return sent.promise; });
    const delivery = h.deliver(entry); await sending.promise;
    await h.port.setSetting("ocr_completed", false, h.clock.now());
    sent.resolve({ id: "accepted-before-cancellation" }); await delivery;
    expect(h.channel.send).toHaveBeenCalledOnce();
    const state = await h.port.inspect(id);
    expect(state?.status).toBe("CANCELLED");
    expect(state?.parts[0]).toMatchObject({ status: "DELIVERED", deliveredMessageId: "accepted-before-cancellation" });
    expect(state?.parts.slice(1).every(part => part.status === "CANCELLED")).toBe(true);
  });

  it("renews the lease while waiting for Discord, without holding a database transaction", async () => {
    const h = resultWorkerHarness(); const id = await h.enqueue(); const entry = await h.claim();
    const sending = deferred<void>(); const sent = deferred<{ id: string }>();
    h.channel.send.mockImplementationOnce(() => { sending.resolve(); return sent.promise; });
    const delivery = h.deliver(entry); await sending.promise;
    await vi.advanceTimersByTimeAsync(31_000);
    expect(h.port.calls.filter(call => call.name === "renew")).toHaveLength(3);
    expect(await h.port.claim({ limit: 1, now: h.clock.now(), claimDurationMs: 30_000 })).toEqual([]);
    sent.resolve({ id: "slow-message" }); await delivery;
    expect(await h.port.inspect(id)).toMatchObject({ status: "DELIVERED", attemptCount: 1 });
  });

  it("stops subsequent sends when renewal fails, even if the started part can still be recorded", async () => {
    const h = resultWorkerHarness(); const id = await h.enqueue(); const entry = await h.claim();
    const sending = deferred<void>(); const sent = deferred<{ id: string }>();
    h.channel.send.mockImplementationOnce(() => { sending.resolve(); return sent.promise; });
    h.port.renew = async () => false;
    const delivery = h.deliver(entry); await sending.promise;
    await vi.advanceTimersByTimeAsync(10_000); sent.resolve({ id: "known" }); await delivery;
    expect(h.channel.send).toHaveBeenCalledOnce();
    expect((await h.port.inspect(id))?.parts[0]).toMatchObject({ status: "DELIVERED" });
  });

  it("bounds an unresponsive Discord call and schedules the same part after an uncertain outcome", async () => {
    const h = resultWorkerHarness(); const id = await h.enqueue(); const entry = await h.claim();
    const sending = deferred<void>(); const never = deferred<{ id: string }>();
    h.channel.send.mockImplementationOnce(() => { sending.resolve(); return never.promise; });
    const delivery = h.deliver(entry); await sending.promise;
    await vi.advanceTimersByTimeAsync(RESULT_NOTIFICATION_SEND_TIMEOUT_MS); await delivery;
    const state = await h.port.inspect(id);
    expect(state).toMatchObject({ status: "PENDING", lastError: "delivery_uncertain" });
    expect(state?.parts.every(part => part.status === "PENDING")).toBe(true);
    never.resolve({ id: "eventually-accepted" });
  });

  it("uses finite retry and safe errors if the completion write is lost after Discord acceptance", async () => {
    const h = resultWorkerHarness(); const id = await h.enqueue("job-1", "Short summary"); const entry = await h.claim();
    h.port.complete = async () => { throw new Error("SQL bind secret canary"); };
    await h.deliver({ ...entry, maxAttempts: 1 });
    expect(await h.port.inspect(id)).toMatchObject({ status: "FAILED", lastError: "delivery_uncertain" });
    expect(JSON.stringify(h.logger.warn.mock.calls)).not.toContain("canary");
    expect(JSON.stringify(h.logger.error.mock.calls)).not.toContain("canary");
  });

  it("moves unsupported stored renderers and invalid payloads to FAILED before Discord I/O", async () => {
    const h = resultWorkerHarness(); const id = await h.enqueue(); const entry = await h.claim();
    await h.deliver({ ...entry, rendererVersion: 99 });
    expect(await h.port.inspect(id)).toMatchObject({ status: "FAILED", lastError: "unsupported_renderer" });
    expect(await h.port.retry(id, h.clock.now())).toBe(true);
    const retry = await h.claim(); await h.deliver({ ...retry, payload: {} });
    expect(await h.port.inspect(id)).toMatchObject({ status: "FAILED", lastError: "invalid_payload" });
    expect(h.client.channels.fetch).not.toHaveBeenCalled(); expect(h.channel.send).not.toHaveBeenCalled();
  });

  it("uses the same nonce for an operator retry and stops new sends during shutdown", async () => {
    const h = resultWorkerHarness(); const id = await h.enqueue(); const entry = await h.claim();
    h.channel.send.mockRejectedValueOnce({ status: 403 }); await h.deliver(entry);
    expect(await h.port.inspect(id)).toMatchObject({ status: "FAILED", lastError: "delivery_failed" });
    await h.port.retry(id, h.clock.now()); const retry = await h.claim();
    h.channel.send.mockImplementationOnce(async () => { h.stop(); return { id: "sent-before-stop" }; });
    await h.deliver(retry);
    expect(h.channel.send).toHaveBeenCalledTimes(2);
    expect(h.channel.send.mock.calls[0]?.[0].nonce).toBe(h.channel.send.mock.calls[1]?.[0].nonce);
    expect((await h.port.inspect(id))?.parts[0]).toMatchObject({ status: "DELIVERED" });
  });
});
