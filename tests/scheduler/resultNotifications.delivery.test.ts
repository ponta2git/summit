import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageFlags } from "discord.js";
import * as Cause from "effect/Cause"; // skipcq: JS-C1003
import * as Effect from "effect/Effect"; // skipcq: JS-C1003
import * as Exit from "effect/Exit"; // skipcq: JS-C1003
import { deliverPreparedResultNotification } from "../../src/notifications/delivery/resultDelivery.ts";
import { prepareResultDelivery } from "../../src/notifications/delivery/definitions/result.ts";
import { notificationNonce } from "../../src/notifications/delivery/deliveryNonce.ts";
import { RESULT_NOTIFICATION_HEARTBEAT_MS, RESULT_NOTIFICATION_SEND_TIMEOUT_MS } from "../../src/config.ts";
import { notificationNow } from "../contracts/resultNotifications.ts";
import { deferred, deferredSignal } from "../helpers/deferred.ts";
import { runEffect } from "../helpers/assertions.ts";
import { resultWorkerHarness } from "./resultNotifications.harness.ts";
import type { ClaimLease } from "../../src/time/lease.ts";
import { InvariantViolationError, NotificationAdmissionInvariantError } from "../../src/errors/index.ts";

describe("result notification delivery", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(notificationNow); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it("prepares detached data synchronously and defers delivery I/O until the Effect runs", async () => {
    const harness = resultWorkerHarness(); await harness.enqueue(); const entry = await harness.claim();
    const context = { ...harness.context };
    const prepared = prepareResultDelivery(entry, context);
    const plan = vi.spyOn(harness.port, "plan");
    const delivery = deliverPreparedResultNotification(harness, prepared);
    context.channelId = "changed-after-preparation";
    expect(plan).not.toHaveBeenCalled();
    expect(harness.client.channels.fetch).not.toHaveBeenCalled();
    await runEffect(delivery);
    expect(harness.client.channels.fetch).toHaveBeenCalledWith("channel-1");
    expect(prepared).not.toHaveProperty("payload");
  });

  it("propagates a rendering defect without converting it into a retryable delivery failure", async () => {
    const harness = resultWorkerHarness(); const id = await harness.enqueue(); const entry = await harness.claim();
    const prepared = prepareResultDelivery(entry, harness.context);
    if (prepared.strategy !== "resumable") { throw new Error("Expected a valid plan"); }
    const defect = new Error("renderer invariant failed");
    const fail = vi.spyOn(harness.port, "fail");
    const exit = await runEffect(Effect.exit(deliverPreparedResultNotification(harness, {
      ...prepared, notification: { ...prepared.notification, parts() { throw defect; } }
    })));
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) { throw new Error("Expected a rendering defect"); }
    expect(Cause.hasDies(exit.cause)).toBe(true);
    expect(Cause.squash(exit.cause)).toBe(defect);
    expect(fail).not.toHaveBeenCalled();
    expect(await harness.port.inspect(id)).toMatchObject({ status: "IN_FLIGHT", lastError: null });
    expect(harness.channel.send).not.toHaveBeenCalled();
  });

  it("preserves a ledger invariant as a defect instead of consuming a Discord retry", async () => {
    const harness = resultWorkerHarness(); await harness.enqueue(); const entry = await harness.claim();
    const failure = new InvariantViolationError("Invalid result I/O reservation");
    vi.spyOn(harness.io, "run").mockImplementation(() => { throw failure; });
    const fail = vi.spyOn(harness.port, "fail");
    const exit = await runEffect(Effect.exit(deliverPreparedResultNotification(harness, prepareResultDelivery(entry, harness.context))));
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) { throw new Error("Expected a ledger defect"); }
    expect(Cause.hasDies(exit.cause)).toBe(true); expect(Cause.squash(exit.cause)).toBe(failure);
    expect(fail).not.toHaveBeenCalled(); expect(harness.channel.send).not.toHaveBeenCalled();
  });

  it("preserves a Discord failure combined with a heartbeat defect without normal retry finalization", async () => {
    const harness = resultWorkerHarness(); await harness.enqueue(); const entry = await harness.claim();
    const started = deferredSignal(); const sending = deferred<{ id: string }>();
    const defect = new NotificationAdmissionInvariantError("heartbeat producer invariant");
    harness.channel.send.mockImplementationOnce(() => { started.resolve(); return sending.promise; });
    harness.port.renew = async () => { throw defect; };
    const fail = vi.spyOn(harness.port, "fail");
    const pending = runEffect(Effect.exit(deliverPreparedResultNotification(harness, prepareResultDelivery(entry, harness.context))));
    try {
      await started.promise;
      await vi.advanceTimersByTimeAsync(RESULT_NOTIFICATION_HEARTBEAT_MS);
    } finally { sending.reject(new Error("Discord unavailable")); }
    const exit = await pending;
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) { throw new Error("Expected both failures"); }
    expect(Cause.hasFails(exit.cause)).toBe(true);
    expect(Cause.hasDies(exit.cause)).toBe(true);
    expect(exit.cause.reasons.filter(Cause.isDieReason).map(reason => reason.defect)).toContain(defect);
    expect(fail).not.toHaveBeenCalled();
    expect(harness.channel.send).toHaveBeenCalledOnce();
  });

  it("recovers the same claim when the transient-lease warning logger throws", async () => {
    const harness = resultWorkerHarness(); const id = await harness.enqueue(); const entry = await harness.claim();
    const started = deferredSignal(); const sending = deferred<{ id: string }>();
    harness.channel.send.mockImplementationOnce(() => { started.resolve(); return sending.promise; });
    const renew = harness.port.renew;
    harness.port.renew = vi.fn<typeof renew>().mockRejectedValueOnce(new Error("Temporary database failure")).mockImplementation(renew);
    harness.logger.warn.mockImplementationOnce(() => { throw new Error("Logging destination failed"); });
    const pending = harness.deliver(entry);
    try {
      await started.promise;
      await vi.advanceTimersByTimeAsync(RESULT_NOTIFICATION_HEARTBEAT_MS + 1_000);
      expect(harness.port.renew).toHaveBeenCalledTimes(2);
    } finally { sending.resolve({ id: "first" }); }
    await pending;
    expect(await harness.port.inspect(id)).toMatchObject({ status: "DELIVERED", attemptCount: 1 });
    expect(harness.port.calls.filter(call => call.name === "claim")).toHaveLength(1);
    expect(harness.port.calls.some(call => call.name === "fail")).toBe(false);
  });

  it("reuses each part's nonce and persisted context, skips delivered parts, and disables mentions", async () => {
    const harness = resultWorkerHarness(); const id = await harness.enqueue(); const entry = await harness.claim();
    harness.channel.send.mockResolvedValueOnce({ id: "first" }).mockRejectedValueOnce(new Error("Response missing"));
    await harness.deliver(entry);
    expect(await harness.port.inspect(id)).toMatchObject({ status: "PENDING", lastError: "delivery_uncertain" });
    const firstPayload = harness.channel.send.mock.calls[0]?.[0];
    const uncertainPayload = harness.channel.send.mock.calls[1]?.[0];
    expect(firstPayload).toMatchObject({ nonce: notificationNonce(id, 0), enforceNonce: true,
      allowedMentions: { parse: [], users: [], roles: [], repliedUser: false }, flags: MessageFlags.SuppressEmbeds });
    await vi.advanceTimersByTimeAsync(1_000);
    const retry = await harness.claim();
    await runEffect(deliverPreparedResultNotification(harness, prepareResultDelivery(retry,
      { channelId: "changed", webOrigin: "https://changed.example.com" })));
    expect(harness.channel.send.mock.calls[2]?.[0]).toEqual(uncertainPayload);
    expect(harness.channel.send.mock.calls.filter(([body]) => body.nonce === firstPayload?.nonce)).toHaveLength(1);
    expect(harness.client.channels.fetch).toHaveBeenLastCalledWith("channel-1");
    expect(await harness.port.inspect(id)).toMatchObject({ status: "DELIVERED" });
    expect(String(firstPayload?.nonce).length).toBeLessThanOrEqual(25);
    expect(notificationNonce(id, 0)).not.toBe(notificationNonce(id, 1));
  });

  it("resumes undelivered parts when persisted delivered numbers have gaps", async () => {
    const harness = resultWorkerHarness(); const id = await harness.enqueue("noncontiguous", "x".repeat(6_000)); const entry = await harness.claim();
    // regression: 配送境界は過去の非連続な完了番号を許容し、連続 prefix とみなさない。
    const begin = vi.fn(harness.port.begin).mockResolvedValue(true);
    const complete = vi.fn(harness.port.complete).mockResolvedValue(true);
    harness.port.begin = begin; harness.port.complete = complete;
    await harness.deliver({ ...entry, deliveredPartNos: [0, 2] });
    expect((await harness.port.inspect(id))?.partCount).toBe(5);
    expect(begin.mock.calls.map(([, partNo]) => partNo)).toEqual([1, 3, 4]);
    expect(complete.mock.calls.map(([, partNo, , messageId]) => ({ partNo, messageId }))).toEqual([
      { partNo: 1, messageId: "message-1" }, { partNo: 3, messageId: "message-2" }, { partNo: 4, messageId: "message-3" }
    ]);
    expect(harness.channel.send.mock.calls.map(([body]) => body.nonce)).toEqual([notificationNonce(id, 1), notificationNonce(id, 3), notificationNonce(id, 4)]);
  });

  it("records an already-started send after OFF and stops all later parts", async () => {
    const harness = resultWorkerHarness(); const id = await harness.enqueue(); const entry = await harness.claim();
    const sending = deferredSignal(); const sent = deferred<{ id: string }>();
    harness.channel.send.mockImplementationOnce(() => { sending.resolve(); return sent.promise; });
    const delivery = harness.deliver(entry); await sending.promise;
    await harness.port.setSetting("analysis_completed", false, harness.clock.now());
    sent.resolve({ id: "accepted-before-cancellation" }); await delivery;
    expect(harness.channel.send).toHaveBeenCalledOnce();
    const state = await harness.port.inspect(id);
    expect(state?.status).toBe("CANCELLED");
    expect(state?.parts[0]).toMatchObject({ status: "DELIVERED", deliveredMessageId: "accepted-before-cancellation" });
    expect(state?.parts.slice(1).every(part => part.status === "CANCELLED")).toBe(true);
  });

  it("renews the lease while waiting for Discord, without holding a database transaction", async () => {
    const harness = resultWorkerHarness(); const id = await harness.enqueue(); const entry = await harness.claim();
    const sending = deferredSignal(); const sent = deferred<{ id: string }>();
    harness.channel.send.mockImplementationOnce(() => { sending.resolve(); return sent.promise; });
    const delivery = harness.deliver(entry); await sending.promise;
    await vi.advanceTimersByTimeAsync(31_000);
    expect(harness.port.calls.filter(call => call.name === "renew")).toHaveLength(3);
    expect(await harness.port.claim({ limit: 1, now: harness.clock.now(), claimDurationMs: 30_000 })).toEqual([]);
    sent.resolve({ id: "slow-message" }); await delivery;
    expect(await harness.port.inspect(id)).toMatchObject({ status: "DELIVERED", attemptCount: 1 });
  });

  it("stops subsequent sends when renewal fails, even if the started part can still be recorded", async () => {
    const harness = resultWorkerHarness(); const id = await harness.enqueue(); const entry = await harness.claim();
    const sending = deferredSignal(); const sent = deferred<{ id: string }>();
    harness.channel.send.mockImplementationOnce(() => { sending.resolve(); return sent.promise; });
    harness.port.renew = async () => null;
    const delivery = harness.deliver(entry); await sending.promise;
    await vi.advanceTimersByTimeAsync(10_000); sent.resolve({ id: "known" }); await delivery;
    expect(harness.channel.send).toHaveBeenCalledOnce();
    expect((await harness.port.inspect(id))?.parts[0]).toMatchObject({ status: "DELIVERED" });
  });

  it("waits for an already-started renewal before releasing the delivery scope", async () => {
    const harness = resultWorkerHarness(); const id = await harness.enqueue("pending-renewal", "Short summary"); const entry = await harness.claim();
    const sending = deferredSignal(); const sent = deferred<{ id: string }>(); const renewed = deferred<ClaimLease | null>();
    harness.channel.send.mockImplementationOnce(() => { sending.resolve(); return sent.promise; });
    harness.port.renew = vi.fn(() => renewed.promise);
    let settled = false;
    const delivery = harness.deliver(entry).then(() => { settled = true; return undefined; });
    try {
      await sending.promise;
      await vi.advanceTimersByTimeAsync(RESULT_NOTIFICATION_HEARTBEAT_MS);
      expect(harness.port.renew).toHaveBeenCalledOnce();
      sent.resolve({ id: "accepted" });
      await vi.advanceTimersByTimeAsync(0);
      expect(await harness.port.inspect(id)).toMatchObject({ status: "DELIVERED" });
      expect(settled).toBe(false);
    } finally { sent.resolve({ id: "accepted" }); renewed.resolve(null); await delivery; }
    expect(settled).toBe(true);
    await vi.advanceTimersByTimeAsync(RESULT_NOTIFICATION_HEARTBEAT_MS * 2);
    expect(harness.port.renew).toHaveBeenCalledOnce();
  });

  it.each(["plan", "begin"] as const)("does not start Discord I/O when the lease is lost during %s", async operation => {
    const harness = resultWorkerHarness(); await harness.enqueue(); const entry = await harness.claim();
    const entered = deferredSignal(); const release = deferredSignal();
    if (operation === "plan") {
      const plan = harness.port.plan;
      harness.port.plan = async (...args) => { const changed = await plan(...args); entered.resolve(); await release.promise; return changed; };
    } else {
      const begin = harness.port.begin;
      harness.port.begin = async (...args) => { const changed = await begin(...args); entered.resolve(); await release.promise; return changed; };
    }
    harness.port.renew = async () => null;
    const delivery = harness.deliver(entry);
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(RESULT_NOTIFICATION_HEARTBEAT_MS);
    } finally { release.resolve(); await delivery; }
    expect(harness.channel.send).not.toHaveBeenCalled();
    expect(harness.client.channels.fetch).toHaveBeenCalledTimes(operation === "plan" ? 0 : 1);
  });

  it("classifies a synchronous renewal failure without leaking it or starting later parts", async () => {
    const harness = resultWorkerHarness(); const id = await harness.enqueue(); const entry = await harness.claim();
    const sending = deferredSignal(); const sent = deferred<{ id: string }>();
    harness.channel.send.mockImplementationOnce(() => { sending.resolve(); return sent.promise; });
    harness.port.renew = () => { throw new Error("private renewal canary"); };
    const delivery = harness.deliver(entry);
    try {
      await sending.promise;
      await vi.advanceTimersByTimeAsync(RESULT_NOTIFICATION_HEARTBEAT_MS);
    } finally { sent.resolve({ id: "already-started" }); await vi.advanceTimersByTimeAsync(7_000); await delivery; }
    expect(harness.channel.send).toHaveBeenCalledOnce();
    expect((await harness.port.inspect(id))?.parts[0]).toMatchObject({ status: "DELIVERED", deliveredMessageId: "already-started" });
    expect(harness.logger.warn).toHaveBeenCalledWith({ event: "result_notification.lease_uncertain", notificationId: id });
    expect(JSON.stringify(harness.logger.warn.mock.calls)).not.toContain("canary");
    expect(JSON.stringify(harness.logger.error.mock.calls)).not.toContain("canary");
  });

  it.each(["plan", "begin"] as const)("classifies a %s database failure before send as retryable delivery failure", async operation => {
    const harness = resultWorkerHarness(); const id = await harness.enqueue(); const entry = await harness.claim();
    harness.port[operation] = () => { throw new Error("private database canary"); };
    await harness.deliver(entry);
    expect(await harness.port.inspect(id)).toMatchObject({ status: "PENDING", lastError: "delivery_failed" });
    expect(harness.channel.send).not.toHaveBeenCalled();
    expect(JSON.stringify(harness.logger.warn.mock.calls)).not.toContain("canary");
  });

  it("bounds an unresponsive Discord call and schedules the same part after an uncertain outcome", async () => {
    const harness = resultWorkerHarness(); const id = await harness.enqueue(); const entry = await harness.claim();
    const sending = deferredSignal(); const never = deferred<{ id: string }>();
    harness.channel.send.mockImplementationOnce(() => { sending.resolve(); return never.promise; });
    const delivery = harness.deliver(entry); await sending.promise;
    await vi.advanceTimersByTimeAsync(RESULT_NOTIFICATION_SEND_TIMEOUT_MS); await delivery;
    const state = await harness.port.inspect(id);
    expect(state).toMatchObject({ status: "PENDING", lastError: "delivery_uncertain" });
    expect(state?.parts.every(part => part.status === "PENDING")).toBe(true);
    never.resolve({ id: "eventually-accepted" });
  });

  it("uses finite retry and safe errors if the completion write is lost after Discord acceptance", async () => {
    const harness = resultWorkerHarness(); const id = await harness.enqueue("job-1", "Short summary"); const entry = await harness.claim();
    harness.port.complete = async () => { throw new Error("SQL bind secret canary"); };
    await harness.deliver({ ...entry, maxAttempts: 1 });
    expect(await harness.port.inspect(id)).toMatchObject({ status: "FAILED", lastError: "delivery_uncertain" });
    expect(JSON.stringify(harness.logger.warn.mock.calls)).not.toContain("canary");
    expect(JSON.stringify(harness.logger.error.mock.calls)).not.toContain("canary");
  });

  it("moves unsupported stored renderers and invalid payloads to FAILED before Discord I/O", async () => {
    const harness = resultWorkerHarness(); const id = await harness.enqueue(); const entry = await harness.claim();
    await harness.deliver({ ...entry, rendererVersion: 99 });
    expect(await harness.port.inspect(id)).toMatchObject({ status: "FAILED", lastError: "unsupported_renderer" });
    expect(await harness.port.retry(id, harness.clock.now())).toBe(true);
    const retry = await harness.claim(); await harness.deliver({ ...retry, payload: {} });
    expect(await harness.port.inspect(id)).toMatchObject({ status: "FAILED", lastError: "invalid_payload" });
    expect(harness.client.channels.fetch).not.toHaveBeenCalled(); expect(harness.channel.send).not.toHaveBeenCalled();
  });

  it("uses the same nonce for an operator retry and stops new sends during shutdown", async () => {
    const harness = resultWorkerHarness(); const id = await harness.enqueue(); const entry = await harness.claim();
    harness.channel.send.mockRejectedValueOnce({ status: 403 }); await harness.deliver(entry);
    expect(await harness.port.inspect(id)).toMatchObject({ status: "FAILED", lastError: "delivery_failed" });
    await harness.port.retry(id, harness.clock.now()); const retry = await harness.claim();
    harness.channel.send.mockImplementationOnce(async () => { harness.stop(); return { id: "sent-before-stop" }; });
    await harness.deliver(retry);
    expect(harness.channel.send).toHaveBeenCalledTimes(2);
    expect(harness.channel.send.mock.calls[0]?.[0].nonce).toBe(harness.channel.send.mock.calls[1]?.[0].nonce);
    expect((await harness.port.inspect(id))?.parts[0]).toMatchObject({ status: "DELIVERED" });
  });
});
