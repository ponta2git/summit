import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createResultIoLedger } from "../../src/notifications/delivery/resultIo.ts";
import { createDeliveryCapacity } from "../../src/notifications/delivery/capacity.ts";
import { runEffect } from "../helpers/assertions.ts";
import { deferred } from "../helpers/deferred.ts";

describe("physical result I/O ownership", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
  const logger = () => ({ info: vi.fn(), warn: vi.fn() });

  it("unions logical and physical owners and retains the original bytes after logical completion", async () => {
    const io = createResultIoLedger({ logger: logger() });
    const capacity = createDeliveryCapacity({ slots: 2, payloadBytes: 100, retained: io.reservations });
    const sent = deferred<string>();
    let sdk: Promise<string> | undefined;
    await runEffect(capacity.start("owner", 80, () => Effect.sync(() => {
      sdk = io.run({ id: "owner", payloadBytes: 80 }, "send", 0, () => sent.promise);
      expect(capacity.snapshot()).toEqual({ slots: 1, payloadBytes: 20, activeIds: ["owner"], allowOversized: false });
      io.detach("owner");
    })));
    await runEffect(capacity.drain());
    expect(capacity.snapshot()).toEqual({ slots: 1, payloadBytes: 20, activeIds: ["owner"], allowOversized: false });
    let drained = false;
    const drain = io.drain().then(() => { drained = true; return undefined; });
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(drained).toBe(false);
    sent.resolve("accepted"); await sdk; await drain;
    expect(capacity.snapshot()).toEqual({ slots: 2, payloadBytes: 100, activeIds: [], allowOversized: true });
    await runEffect(capacity.close());
  });

  it("registers before SDK invocation, releases a synchronous failure, and refuses duplicate pending work", async () => {
    const io = createResultIoLedger({ logger: logger() });
    const owner = { id: "owner", payloadBytes: 40 };
    const failure = new Error("private SDK value");
    const thrown = io.run(owner, "channel", null, () => {
      expect(io.reservations()).toEqual([owner]);
      throw failure;
    });
    expect(() => io.run(owner, "channel", null, async () => "duplicate")).toThrow("Invalid result I/O reservation");
    await expect(thrown).rejects.toBe(failure);
    expect(io.snapshot()).toEqual({ pending: 0, payloadBytes: 0, oldestAgeMs: 0 });
    io.stop();
    expect(() => io.run(owner, "send", 0, async () => "after-stop")).toThrow("Invalid result I/O reservation");
  });

  it("releases and wakes exactly once even when late-success diagnostics throw", async () => {
    const log = logger(); const onSettled = vi.fn();
    log.info.mockImplementation(() => { throw new Error("logger unavailable"); });
    const io = createResultIoLedger({ logger: log, onSettled });
    const sent = deferred<string>();
    const work = io.run({ id: "owner", payloadBytes: 40 }, "send", 2, () => sent.promise);
    io.detach("owner"); io.detach("owner");
    sent.resolve("accepted");
    expect(await work).toBe("accepted");
    await io.drain();
    expect(io.reservations()).toEqual([]);
    expect(onSettled).toHaveBeenCalledOnce();
    expect(log.info).toHaveBeenCalledExactlyOnceWith({ event: "result_notification.io_late_success",
      notificationId: "owner", operation: "send", partNo: 2, elapsedMs: 0 });
  });

  it("bounds monitoring during a twenty-minute outage without retaining payloads or errors", async () => {
    const log = logger(); const io = createResultIoLedger({ logger: log });
    const done = deferred<void>();
    const work = ["a", "b"].map(id => io.run({ id, payloadBytes: 100 }, "send", 0, () => done.promise));
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(io.snapshot()).toEqual({ pending: 2, payloadBytes: 200, oldestAgeMs: 20 * 60_000 });
    expect(log.warn).toHaveBeenCalledTimes(19);
    expect(log.warn.mock.calls[0]?.[0]).toEqual({ event: "result_notification.io_pending", pending: 2,
      payloadBytes: 200, oldestAgeMs: 90_000, saturatedForMs: 90_000, investigate: false });
    expect(log.warn.mock.calls.at(-1)?.[0]).toMatchObject({ investigate: true });
    done.resolve(); await Promise.all(work);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(log.warn).toHaveBeenCalledTimes(19);
  });
});
