import { setImmediate } from "node:timers/promises";
import { ResultAsync } from "neverthrow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../helpers/deferred.ts";
import type * as Environment from "../../src/env.ts";
import type { ShutdownDeps } from "../../src/shutdown.ts";

// why: bootstrapのcompositionを駆動し、停止が途中の起動やresource drainを追い越さないことを検証する。
const h = vi.hoisted(() => ({
  phase: "", pending: Promise.resolve(), calls: [] as string[], shuttingDown: false,
  signals: new Map<string | symbol, () => void>(), shutdown: undefined as Promise<void> | undefined,
  step: async (phase: string): Promise<void> => { h.calls.push(phase); if (h.phase === phase) { await h.pending; } },
  resource: (name: string) => ({ stop: () => { h.calls.push(`${name}.stop`); }, drain: () => h.step(`${name}.drain`) })
}));
vi.mock("../../src/appContext.ts", () => ({ createAppContext: () => ({}) }));
vi.mock("../../src/db/client.ts", () => ({ db: {}, closeDb: () => h.step("database.close") }));
vi.mock("../../src/features/ask-session/send.ts", () => ({ waitForInFlightSend: () => h.step("asks.drain") }));
vi.mock("../../src/discord/client.ts", () => ({ createDiscordClient: () => ({
  login: () => h.step("login"), destroy: () => { h.calls.push("discord.destroy"); }
}) }));
vi.mock("../../src/discord/index.ts", () => ({ registerInteractionHandlers: () => h.resource("interactions") }));
vi.mock("../../src/members/reconcile.ts", () => ({ reconcileMembers: () => h.step("members") }));
vi.mock("../../src/startup/rateLimitLogging.ts", () => ({ attachRateLimitLogging: vi.fn() }));
vi.mock("../../src/startup/appReadiness.ts", () => ({
  createAppReadiness: () => ({ state: { ready: false }, markReady: () => { h.calls.push("ready"); }, markNotReady: vi.fn() }),
  registerReconnectReplayHandlers: () => ({ ...h.resource("reconnect"), completeStartup: () => { h.calls.push("ready"); } })
}));
vi.mock("../../src/scheduler/reconciler.ts", () => ({ runReconciler: () => ResultAsync.fromPromise(h.step("reconcile"), error => error).map(() => ({})) }));
vi.mock("../../src/scheduler/index.ts", () => ({
  runStartupRecovery: () => ResultAsync.fromPromise(h.step("recovery"), error => error),
  createAskScheduler: () => { h.calls.push("scheduler.create"); return { ...h.resource("scheduler"), wake: vi.fn() }; }
}));
vi.mock("../../src/env.ts", async importOriginal => {
  const actual = await importOriginal<typeof Environment>();
  return { ...actual, env: { ...actual.env, RESULT_NOTIFICATION_TOKEN: "dummy-receipt-token",
    RESULT_NOTIFICATION_OPERATIONS_TOKEN: "dummy-operations-token", RESULT_NOTIFICATION_WEB_ORIGIN: "https://example.invalid" } };
});
vi.mock("../../src/notifications/runtime.ts", () => ({ createResultNotificationRuntime: () => ({
  ...h.resource("results"), start: () => h.step("receiver"), wake: vi.fn()
}) }));
vi.mock("../../src/shutdown.ts", () => ({
  isShuttingDown: () => h.shuttingDown,
  shutdownGracefully: (deps: ShutdownDeps) => {
    h.shuttingDown = true; deps.stopScheduler();
    h.shutdown = (async () => { await deps.waitForInFlightSend(); await deps.closeDb(); deps.destroyClient(); })();
    // The process exit belongs to shutdownGracefully's caller; retain this test process.
    return h.shutdown.then(() => false);
  }
}));

describe("bootstrap shutdown ownership", () => {
  let releaseWork: (() => void) | undefined;
  const phases = ["members", "receiver", "login", "reconcile", "recovery"];
  beforeEach(() => {
    releaseWork = undefined; vi.resetModules(); h.calls = []; h.shuttingDown = false; h.signals.clear(); h.shutdown = undefined;
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
});
