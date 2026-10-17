import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Environment from "../../src/env.ts";
import { deferred } from "../helpers/deferred.ts";

const h = vi.hoisted(() => ({
  normalLoaded: vi.fn(), databaseCreated: vi.fn(), probe: vi.fn(), close: vi.fn(), start: vi.fn(), stop: vi.fn(), drain: vi.fn(),
  signals: new Map<string | symbol, () => void>()
}));
vi.mock("../../src/startup/normal.ts", () => { h.normalLoaded(); throw new Error("Business bootstrap must stay unloaded"); });
vi.mock("../../src/startup/maintenanceDatabase.ts", () => ({ createMaintenanceDatabase: () => {
  h.databaseCreated(); return { probe: h.probe, close: h.close };
} }));
vi.mock("../../src/startup/maintenanceReadiness.ts", () => ({ createMaintenanceReadiness: () => ({
  start: h.start, stop: h.stop, drain: h.drain
}) }));
vi.mock("../../src/env.ts", async importOriginal => {
  const actual = await importOriginal<typeof Environment>();
  return { env: { ...actual.env, MOMO_MAINTENANCE_MODE: "frozen", RESULT_NOTIFICATION_OPERATIONS_TOKEN: "o".repeat(32) } };
});

describe("frozen bootstrap ownership", () => {
  beforeEach(() => {
    vi.resetModules(); vi.resetAllMocks(); h.signals.clear();
    h.start.mockResolvedValue(undefined); h.drain.mockResolvedValue(undefined); h.close.mockResolvedValue(undefined);
    vi.spyOn(process, "once").mockImplementation((event, listener) => { h.signals.set(event, () => { listener(); }); return process; });
    vi.spyOn(process, "exit").mockImplementation(vi.fn<typeof process.exit>());
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("keeps business bootstrap unloaded on repeated frozen process starts", async () => {
    for (let restart = 0; restart < 2; restart += 1) {
      vi.resetModules(); await import("../../src/index.ts"); await setImmediate();
      expect(h.start).toHaveBeenCalledTimes(restart + 1);
      h.signals.get("SIGTERM")?.(); await setImmediate();
      expect(h.close).toHaveBeenCalledTimes(restart + 1);
    }
    expect(h.normalLoaded).not.toHaveBeenCalled(); expect(h.probe).not.toHaveBeenCalled();
    expect(h.databaseCreated).toHaveBeenCalledTimes(2);
    expect(process.exit).toHaveBeenNthCalledWith(1, 0); expect(process.exit).toHaveBeenNthCalledWith(2, 0);
  });

  it("waits for readiness and pool close, including duplicate signals", async () => {
    const draining = deferred<void>(); const closing = deferred<void>();
    h.drain.mockReturnValue(draining.promise); h.close.mockReturnValue(closing.promise);
    await import("../../src/index.ts"); await setImmediate();
    h.signals.get("SIGTERM")?.(); h.signals.get("SIGINT")?.(); await setImmediate();
    expect(h.stop).toHaveBeenCalledOnce(); expect(h.drain).toHaveBeenCalledOnce(); expect(h.close).toHaveBeenCalledOnce();
    expect(process.exit).not.toHaveBeenCalled();
    draining.resolve(); await setImmediate(); expect(process.exit).not.toHaveBeenCalled();
    closing.resolve(); await setImmediate(); expect(process.exit).toHaveBeenCalledWith(0);
    expect(h.normalLoaded).not.toHaveBeenCalled();
  });

  it("closes the database after listener startup fails", async () => {
    h.start.mockRejectedValue(new Error("PRIVATE-BIND-DETAIL"));
    await import("../../src/index.ts"); await setImmediate();
    expect(h.stop).toHaveBeenCalledOnce(); expect(h.drain).toHaveBeenCalledOnce(); expect(h.close).toHaveBeenCalledOnce();
    expect(process.exit).toHaveBeenCalledWith(1); expect(h.normalLoaded).not.toHaveBeenCalled();
  });

  it("retains pool close and drain when listener stop throws", async () => {
    h.stop.mockImplementation(() => { throw new Error("stop failed"); });
    await import("../../src/index.ts"); await setImmediate();
    h.signals.get("SIGTERM")?.(); await setImmediate();
    expect(h.drain).toHaveBeenCalledOnce(); expect(h.close).toHaveBeenCalledOnce();
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});
