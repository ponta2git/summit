import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMaintenanceDrain } from "../../src/startup/maintenanceDrain.ts";
import { deferred } from "../helpers/deferred.ts";

const cutover = { cutoverId: "cutover-20261018", stopEpoch: 1 };
describe("maintenance drain ownership", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("closes admission immediately, retains receipts until all, and reports actual settlement independently", async () => {
    const admission = deferred<void>(); const delivery = deferred<void>(); const stops: string[] = [];
    const maintenance = createMaintenanceDrain([
      { name: "admission", stage: "admission", stop: () => { stops.push("admission"); }, drain: () => admission.promise },
      { name: "delivery", stage: "all", stop: () => { stops.push("delivery"); }, drain: () => delivery.promise }
    ]);
    const before = maintenance.snapshot();
    expect(maintenance.request({ ...cutover, stage: "admission" })).toBe("accepted");
    expect(maintenance.admissionOpen).toBe(false); expect(maintenance.receiptsOpen).toBe(true);
    expect(maintenance.snapshot()).toStrictEqual({ consumer: "summit", scope: "process", ...cutover,
      stage: "admission", phase: "draining", writers: [
        { name: "admission", stage: "admission", status: "draining" }, { name: "delivery", stage: "all", status: "active" }
      ] });
    expect(before.writers[0]?.status).toBe("active");
    admission.resolve(); await setImmediate();
    expect(maintenance.snapshot().phase).toBe("drained");
    expect(maintenance.request({ ...cutover, stage: "all" })).toBe("accepted");
    expect(maintenance.receiptsOpen).toBe(false);
    expect(maintenance.snapshot().phase).toBe("draining");
    expect(maintenance.request({ ...cutover, stage: "all" })).toBe("accepted");
    expect(stops).toStrictEqual(["admission", "delivery"]);
    delivery.resolve(); await setImmediate(); expect(maintenance.snapshot().phase).toBe("drained");
  });

  it("rejects identity changes and stage reversal without reopening any gate", async () => {
    const maintenance = createMaintenanceDrain([]);
    expect(maintenance.request({ ...cutover, stage: "all" })).toBe("accepted");
    for (const next of [{ ...cutover, stage: "admission" as const }, { ...cutover, cutoverId: "another", stage: "all" as const },
      { ...cutover, stopEpoch: 2, stage: "all" as const }]) {
      expect(maintenance.request(next)).toBe("conflict");
    }
    expect(maintenance.snapshot()).toMatchObject({ ...cutover, stage: "all", phase: "drained" });
    expect(maintenance.admissionOpen).toBe(false); expect(maintenance.receiptsOpen).toBe(false);
  });

  it("retains a timeout after late I/O completion without treating a duplicate as a fresh attempt", async () => {
    vi.useFakeTimers(); const pending = deferred<void>(); const stop = vi.fn();
    const maintenance = createMaintenanceDrain([{ name: "send", stage: "all", stop, drain: () => pending.promise }], 100);
    maintenance.request({ ...cutover, stage: "all" });
    await vi.advanceTimersByTimeAsync(99); expect(maintenance.snapshot().phase).toBe("draining");
    await vi.advanceTimersByTimeAsync(1); expect(maintenance.snapshot()).toMatchObject({ phase: "timed_out", writers: [
      { status: "timed_out", failure: "drain_timeout" }
    ] });
    pending.resolve(); await vi.advanceTimersByTimeAsync(0);
    maintenance.request({ ...cutover, stage: "all" });
    expect(stop).toHaveBeenCalledOnce(); expect(maintenance.snapshot().phase).toBe("timed_out");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports stop and drain failures while retaining all remaining owners", async () => {
    const pending = deferred<void>(); const drain = vi.fn(async () => undefined);
    const maintenance = createMaintenanceDrain([
      { name: "broken_stop", stage: "admission", stop: () => { throw new Error("private canary"); }, drain },
      { name: "broken_drain", stage: "admission", stop: () => undefined, drain: () => { throw new Error("private canary"); } },
      { name: "pending", stage: "all", stop: () => undefined, drain: () => pending.promise }
    ]);
    maintenance.request({ ...cutover, stage: "all" }); await setImmediate();
    expect(drain).toHaveBeenCalledOnce();
    expect(maintenance.snapshot()).toMatchObject({ phase: "failed", writers: [
      { status: "failed", failure: "stop_failed" }, { status: "failed", failure: "drain_failed" }, { status: "draining" }
    ] });
    pending.resolve(); await setImmediate(); expect(maintenance.snapshot().writers[2]?.status).toBe("drained");
    expect(JSON.stringify(maintenance.snapshot())).not.toContain("canary");
  });
});
