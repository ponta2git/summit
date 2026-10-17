import { setImmediate } from "node:timers/promises";
import * as Effect from "effect/Effect";
import { promiseCall } from "../../src/runtime/effect.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../helpers/deferred.ts";
import type * as Environment from "../../src/env.ts";
import type { ShutdownDeps } from "../../src/shutdown.ts";
import type { MaintenanceDrain } from "../../src/startup/maintenanceDrain.ts";

// why: bootstrapのcompositionを駆動し、停止が途中の起動やresource drainを追い越さないことを検証する。
const h = vi.hoisted(() => ({
  phase: "", pending: Promise.resolve(), calls: [] as string[], shuttingDown: false,
  failures: new Set<string>(),
  maintenance: undefined as MaintenanceDrain | undefined,
  getReadyState: undefined as (() => { readonly ready: boolean }) | undefined,
  markReady: () => undefined as void,
  signals: new Map<string | symbol, () => void>(), shutdown: undefined as Promise<void> | undefined,
  step: async (phase: string): Promise<void> => { h.calls.push(phase); if (h.phase === phase) { await h.pending; } },
  resource: (name: string) => ({ stop: () => {
    h.calls.push(`${name}.stop`); if (h.failures.has(`${name}.stop`)) { throw new Error("stop failed"); }
  }, drain: () => {
    if (h.failures.has(`${name}.drain`)) { h.calls.push(`${name}.drain`); throw new Error("drain failed"); }
    return h.step(`${name}.drain`);
  } })
}));
vi.mock("../../src/appContext.ts", () => ({ createAppContext: () => ({}) }));
vi.mock("../../src/db/client.ts", () => ({ db: {}, closeDb: () => h.step("database.close") }));
vi.mock("../../src/features/ask-session/send.ts", () => ({ waitForInFlightSend: () => h.step("asks.drain") }));
vi.mock("../../src/discord/client.ts", () => ({ createDiscordClient: () => ({
  login: () => h.step("login"), destroy: () => { h.calls.push("discord.destroy"); }
}) }));
vi.mock("../../src/discord/index.ts", () => ({ registerInteractionHandlers: (
  _client: unknown, _context: unknown, options: { getReadyState: () => { readonly ready: boolean } }
) => { h.getReadyState = options.getReadyState; return h.resource("interactions"); } }));
vi.mock("../../src/members/reconcile.ts", () => ({ reconcileMembers: () => h.step("members") }));
vi.mock("../../src/startup/rateLimitLogging.ts", () => ({ attachRateLimitLogging: vi.fn() }));
vi.mock("../../src/startup/appReadiness.ts", () => ({
  createAppReadiness: () => {
    const state = { ready: false };
    h.markReady = () => { state.ready = true; h.calls.push("ready"); };
    return { state, markReady: h.markReady, markNotReady: () => { state.ready = false; } };
  },
  registerReconnectReplayHandlers: () => ({ ...h.resource("reconnect"), completeStartup: () => { h.calls.push("ready"); } })
}));
vi.mock("../../src/scheduler/reconciler.ts", () => ({ runReconciler: () => promiseCall(() => h.step("reconcile")).pipe(Effect.as({})) }));
vi.mock("../../src/scheduler/index.ts", () => ({
  runStartupRecovery: () => promiseCall(() => h.step("recovery")),
  createAskScheduler: () => { h.calls.push("scheduler.create"); return { ...h.resource("scheduler"), wake: vi.fn() }; }
}));
vi.mock("../../src/env.ts", async importOriginal => {
  const actual = await importOriginal<typeof Environment>();
  return { ...actual, env: { ...actual.env, RESULT_NOTIFICATION_TOKEN: "dummy-receipt-token",
    RESULT_NOTIFICATION_OPERATIONS_TOKEN: "dummy-operations-token", RESULT_NOTIFICATION_WEB_ORIGIN: "https://example.invalid" } };
});
vi.mock("../../src/notifications/runtime.ts", () => ({ createResultNotificationRuntime: (deps: { maintenance: MaintenanceDrain }) => {
  h.maintenance = deps.maintenance;
  const business = h.resource("results.business");
  return { ...h.resource("results"), start: () => h.step("receiver"), wake: vi.fn(),
    drainOperations: () => h.step("results.operations.drain"), stopBusiness: business.stop, drainBusiness: business.drain };
} }));
vi.mock("../../src/shutdown.ts", () => ({
  isShuttingDown: () => h.shuttingDown,
  shutdownGracefully: (deps: ShutdownDeps) => {
    h.shuttingDown = true;
    try { deps.stopScheduler(); } catch { /* The real boundary logs and continues cleanup. */ }
    h.shutdown = (async () => {
      try { await deps.waitForInFlightSend(); } catch { /* The real boundary logs and continues cleanup. */ }
      await deps.closeDb(); await deps.destroyClient();
    })();
    // The process exit belongs to shutdownGracefully's caller; retain this test process.
    return h.shutdown.then(() => ({ status: "already_in_progress" }));
  }
}));

describe("bootstrap shutdown ownership", () => {
  let releaseWork: (() => void) | undefined;
  const phases = ["members", "receiver", "login", "reconcile", "recovery"];
  beforeEach(() => {
    releaseWork = undefined; vi.resetModules(); h.calls = []; h.shuttingDown = false; h.signals.clear(); h.shutdown = undefined; h.failures.clear();
    h.maintenance = undefined; h.getReadyState = undefined;
    vi.spyOn(process, "once").mockImplementation((event, listener) => { h.signals.set(event, () => { listener(); }); return process; });
  });
  afterEach(async () => {
    try {
      if (!h.shuttingDown) { h.signals.get("SIGTERM")?.(); }
      releaseWork?.();
      await h.shutdown;
    } finally { vi.restoreAllMocks(); }
  });

  it.each(phases)("drains startup paused in %s without starting later phases", async phase => {
    const gate = deferred<void>(); releaseWork = () => gate.resolve(); h.phase = phase; h.pending = gate.promise;
    await import("../../src/index.ts"); await setImmediate();
    expect(h.calls.at(-1)).toBe(phase);
    h.signals.get("SIGTERM")?.(); await setImmediate();
    expect(h.calls).not.toContain("database.close");
    gate.resolve(); await h.shutdown;
    expect(h.calls.filter(call => phases.includes(call))).toStrictEqual(phases.slice(0, phases.indexOf(phase) + 1));
    expect(h.calls).not.toContain("ready"); expect(h.calls).not.toContain("scheduler.create");
    expect(h.calls.slice(-2)).toEqual(["database.close", "discord.destroy"]);
    expect(h.calls).toEqual(expect.arrayContaining(["interactions.stop", "reconnect.stop", "results.stop",
      "interactions.drain", "reconnect.drain", "results.drain", "asks.drain"]));
  });

  it.each(["interactions", "reconnect", "scheduler", "results"])("waits for active %s before closing database and Discord", async resource => {
    const gate = deferred<void>(); releaseWork = () => gate.resolve(); h.phase = `${resource}.drain`; h.pending = gate.promise;
    await import("../../src/index.ts"); await setImmediate();
    expect(h.calls).toContain("scheduler.create");
    h.signals.get("SIGTERM")?.(); await setImmediate();
    expect(h.calls).toContain(`${resource}.stop`); expect(h.calls).not.toContain("database.close");
    gate.resolve(); await h.shutdown;
    expect(h.calls.slice(-2)).toEqual(["database.close", "discord.destroy"]);
  });

  it.each(["interactions.stop", "interactions.drain"])("retains all other owners when %s throws synchronously", async failure => {
    const gate = deferred<void>(); releaseWork = () => gate.resolve(); h.phase = "results.drain"; h.pending = gate.promise;
    h.failures.add(failure);
    await import("../../src/index.ts"); await setImmediate();
    h.signals.get("SIGTERM")?.(); await setImmediate();
    expect(h.calls).toEqual(expect.arrayContaining(["interactions.stop", "reconnect.stop", "results.stop", "scheduler.stop",
      "interactions.drain", "reconnect.drain", "results.drain", "scheduler.drain", "asks.drain"]));
    expect(h.calls).not.toContain("database.close");
    gate.resolve(); await h.shutdown;
    expect(h.calls.slice(-2)).toEqual(["database.close", "discord.destroy"]);
  });

  it.each(["receiver", "login", "reconcile", "recovery"])("does not resume startup after maintenance begins during %s", async phase => {
    const gate = deferred<void>(); releaseWork = () => gate.resolve(); h.phase = phase; h.pending = gate.promise;
    await import("../../src/index.ts"); await setImmediate();
    h.maintenance?.request({ cutoverId: "startup-cutover", stopEpoch: 1, stage: "admission" });
    expect(h.maintenance?.snapshot().phase).toBe("draining");
    expect(h.calls).not.toContain("results.stop"); expect(h.calls).not.toContain("results.business.stop");
    gate.resolve(); await setImmediate(); await setImmediate();
    expect(h.calls.filter(call => phases.includes(call))).toStrictEqual(phases.slice(0, phases.indexOf(phase) + 1));
    expect(h.calls).not.toContain("scheduler.create"); expect(h.calls).not.toContain("ready");
    expect(h.maintenance?.snapshot().phase).toBe("drained");
  });

  it("keeps maintenance admission closed after late readiness changes, and drains delivery only in all", async () => {
    const gate = deferred<void>(); releaseWork = () => gate.resolve(); h.phase = "results.business.drain"; h.pending = gate.promise;
    await import("../../src/index.ts"); await setImmediate();
    h.maintenance?.request({ cutoverId: "live-cutover", stopEpoch: 1, stage: "admission" });
    h.markReady(); expect(h.getReadyState?.().ready).toBe(false);
    expect(h.calls).toEqual(expect.arrayContaining(["interactions.stop", "reconnect.stop", "scheduler.stop"]));
    expect(h.calls).not.toContain("results.business.stop");
    h.maintenance?.request({ cutoverId: "live-cutover", stopEpoch: 1, stage: "all" }); await setImmediate();
    expect(h.calls).toContain("results.business.stop"); expect(h.calls).not.toContain("results.stop");
    expect(h.maintenance?.snapshot().phase).toBe("draining");
    gate.resolve(); await setImmediate(); expect(h.maintenance?.snapshot().phase).toBe("drained");
    expect(h.calls).not.toContain("database.close"); expect(h.calls).not.toContain("discord.destroy");
  });
});
