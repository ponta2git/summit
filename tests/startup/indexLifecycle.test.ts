import { setImmediate } from "node:timers/promises";
import * as Effect from "effect/Effect"; // skipcq: JS-C1003
import { promiseCall } from "../../src/runtime/effect.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deferredSignal } from "../helpers/deferred.ts";
import type * as Environment from "../../src/env.ts"; // skipcq: JS-C1003
import type { ShutdownDeps } from "../../src/shutdown.ts";

// why: bootstrapのcompositionを駆動し、停止が途中の起動やresource drainを追い越さないことを検証する。
const harness = vi.hoisted(() => ({
  phase: "", pending: Promise.resolve(), calls: [] as string[], shuttingDown: false,
  failures: new Set<string>(),
  signals: new Map<string | symbol, () => void>(), shutdown: undefined as Promise<void> | undefined,
  step: async (phase: string): Promise<void> => { harness.calls.push(phase); if (harness.phase === phase) { await harness.pending; } },
  resource: (name: string) => ({ stop: () => {
    harness.calls.push(`${name}.stop`); if (harness.failures.has(`${name}.stop`)) { throw new Error("stop failed"); }
  }, drain: () => {
    if (harness.failures.has(`${name}.drain`)) { harness.calls.push(`${name}.drain`); throw new Error("drain failed"); }
    return harness.step(`${name}.drain`);
  } })
}));
vi.mock("../../src/appContext.ts", () => ({ createAppContext: () => ({}) }));
vi.mock("../../src/db/client.ts", () => ({ db: {}, closeDb: () => harness.step("database.close") }));
vi.mock("../../src/features/ask-session/send.ts", () => ({ waitForInFlightSend: () => harness.step("asks.drain") }));
vi.mock("../../src/discord/client.ts", () => ({ createDiscordClient: () => ({
  login: () => harness.step("login"), destroy: () => { harness.calls.push("discord.destroy"); }
}) }));
vi.mock("../../src/discord/index.ts", () => ({ registerInteractionHandlers: () => harness.resource("interactions") }));
vi.mock("../../src/members/reconcile.ts", () => ({ reconcileMembers: () => harness.step("members") }));
vi.mock("../../src/startup/rateLimitLogging.ts", () => ({ attachRateLimitLogging: vi.fn() }));
vi.mock("../../src/startup/appReadiness.ts", () => ({
  createAppReadiness: () => ({ state: { ready: false }, markReady: () => { harness.calls.push("ready"); }, markNotReady: vi.fn() }),
  registerReconnectReplayHandlers: () => ({ ...harness.resource("reconnect"), completeStartup: () => { harness.calls.push("ready"); } })
}));
vi.mock("../../src/scheduler/reconciler.ts", () => ({ runReconciler: () => promiseCall(() => harness.step("reconcile")).pipe(Effect.as({})) }));
vi.mock("../../src/scheduler/index.ts", () => ({
  runStartupRecovery: () => promiseCall(() => harness.step("recovery")),
  createAskScheduler: () => { harness.calls.push("scheduler.create"); return { ...harness.resource("scheduler"), wake: vi.fn() }; }
}));
vi.mock("../../src/env.ts", async importOriginal => {
  const actual = await importOriginal<typeof Environment>();
  return { ...actual, env: { ...actual.env, RESULT_NOTIFICATION_TOKEN: "dummy-receipt-token",
    RESULT_NOTIFICATION_OPERATIONS_TOKEN: "dummy-operations-token", RESULT_NOTIFICATION_WEB_ORIGIN: "https://example.invalid" } };
});
vi.mock("../../src/notifications/runtime.ts", () => ({ createResultNotificationRuntime: () => ({
  ...harness.resource("results"), start: () => harness.step("receiver"), wake: vi.fn()
}) }));
vi.mock("../../src/shutdown.ts", () => ({
  isShuttingDown: () => harness.shuttingDown,
  shutdownGracefully: (deps: ShutdownDeps) => {
    harness.shuttingDown = true;
    try { deps.stopScheduler(); } catch { /* The real boundary logs and continues cleanup. */ }
    harness.shutdown = (async () => {
      try { await deps.waitForInFlightSend(); } catch { /* The real boundary logs and continues cleanup. */ }
      await deps.closeDb(); await deps.destroyClient();
    })();
    // The process exit belongs to shutdownGracefully's caller; retain this test process.
    return harness.shutdown.then(() => false);
  }
}));

describe("bootstrap shutdown ownership", () => {
  let releaseWork: (() => void) | undefined;
  const phases = ["members", "receiver", "login", "recovery", "reconcile"];
  beforeEach(() => {
    releaseWork = undefined; vi.resetModules(); harness.calls = []; harness.shuttingDown = false; harness.signals.clear(); harness.shutdown = undefined; harness.failures.clear();
    vi.spyOn(process, "once").mockImplementation((event, listener) => { harness.signals.set(event, () => { listener(); }); return process; });
  });
  afterEach(async () => {
    try {
      if (!harness.shuttingDown) { harness.signals.get("SIGTERM")?.(); }
      releaseWork?.();
      await harness.shutdown;
    } finally { vi.restoreAllMocks(); }
  });

  it.each(phases)("drains startup paused in %s without starting later phases", async phase => {
    const gate = deferredSignal(); releaseWork = () => gate.resolve(); harness.phase = phase; harness.pending = gate.promise;
    await import("../../src/index.ts"); await setImmediate();
    expect(harness.calls.at(-1)).toBe(phase);
    harness.signals.get("SIGTERM")?.(); await setImmediate();
    expect(harness.calls).not.toContain("database.close");
    gate.resolve(); await harness.shutdown;
    expect(harness.calls.filter(call => phases.includes(call))).toStrictEqual(phases.slice(0, phases.indexOf(phase) + 1));
    expect(harness.calls).not.toContain("ready"); expect(harness.calls).not.toContain("scheduler.create");
    expect(harness.calls.slice(-2)).toEqual(["database.close", "discord.destroy"]);
    expect(harness.calls).toEqual(expect.arrayContaining(["interactions.stop", "reconnect.stop", "results.stop",
      "interactions.drain", "reconnect.drain", "results.drain", "asks.drain"]));
  });

  it.each(["interactions", "reconnect", "scheduler", "results"])("waits for active %s before closing database and Discord", async resource => {
    const gate = deferredSignal(); releaseWork = () => gate.resolve(); harness.phase = `${resource}.drain`; harness.pending = gate.promise;
    await import("../../src/index.ts"); await setImmediate();
    expect(harness.calls).toContain("scheduler.create");
    harness.signals.get("SIGTERM")?.(); await setImmediate();
    expect(harness.calls).toContain(`${resource}.stop`); expect(harness.calls).not.toContain("database.close");
    gate.resolve(); await harness.shutdown;
    expect(harness.calls.slice(-2)).toEqual(["database.close", "discord.destroy"]);
  });

  it.each(["interactions.stop", "interactions.drain"])("retains all other owners when %s throws synchronously", async failure => {
    const gate = deferredSignal(); releaseWork = () => gate.resolve(); harness.phase = "results.drain"; harness.pending = gate.promise;
    harness.failures.add(failure);
    await import("../../src/index.ts"); await setImmediate();
    harness.signals.get("SIGTERM")?.(); await setImmediate();
    expect(harness.calls).toEqual(expect.arrayContaining(["interactions.stop", "reconnect.stop", "results.stop", "scheduler.stop",
      "interactions.drain", "reconnect.drain", "results.drain", "scheduler.drain", "asks.drain"]));
    expect(harness.calls).not.toContain("database.close");
    gate.resolve(); await harness.shutdown;
    expect(harness.calls.slice(-2)).toEqual(["database.close", "discord.destroy"]);
  });

  it("completes startup and resource shutdown when diagnostic sinks throw", async () => {
    harness.phase = ""; harness.pending = Promise.resolve();
    const { logger } = await import("../../src/logger.ts");
    for (const method of ["info", "warn", "error"] as const) {
      vi.spyOn(logger, method).mockImplementation(() => { throw new Error("diagnostics unavailable"); });
    }
    await import("../../src/index.ts"); await setImmediate();
    expect(harness.calls).toContain("scheduler.create");
    expect(harness.calls).toContain("ready");
    harness.signals.get("SIGTERM")?.(); await harness.shutdown;
    expect(harness.calls.slice(-2)).toEqual(["database.close", "discord.destroy"]);
  });
});
