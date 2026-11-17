import { setImmediate } from "node:timers/promises";
import * as Effect from "effect/Effect"; // skipcq: JS-C1003
import { fromDatabaseCall } from "../../src/errors/effect.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppReadiness, registerReconnectReplayHandlers } from "../../src/startup/appReadiness.ts";
import { RECONNECT_REPLAY_DEBOUNCE_MS } from "../../src/config.ts";
import { DatabaseError } from "../../src/errors/index.ts";
import { logger } from "../../src/logger.ts";
import { runReconciler } from "../../src/scheduler/reconciler.ts";
import { runStartupRecovery } from "../../src/scheduler/index.ts";
import { createTestAppContext } from "../testing/ports.ts";
import { asDiscordClient } from "../helpers/discord.ts";
import { deferred } from "../helpers/deferred.ts";

// why: replay対象のorchestration entryだけを差し替え、実際のイベント制御・readinessを検証する。
vi.mock("../../src/scheduler/reconciler.ts", () => ({ runReconciler: vi.fn() }));
vi.mock("../../src/scheduler/index.ts", () => ({ runStartupRecovery: vi.fn() }));
const report = { cancelledPromoted: 0, askCreated: 0, messageIntentsQueued: 0, outboxClaimReleased: 0,
  outboxDeadLettersRequeued: 0, outboxSuccessorsRequeued: 0, failures: [] };
const recovered = { processed: 0, succeeded: 0, failures: [] };
const epoch = Date.parse("2026-04-24T12:00:00Z");

const createHarness = (startupCompleted = true) => {
  const listeners = new Map<string, () => void>();
  const client = asDiscordClient({ on: (event: string, callback: () => void) => { listeners.set(event, callback); },
    off: (event: string) => { listeners.delete(event); } });
  const context = createTestAppContext(); const readiness = createAppReadiness(); const wake = vi.fn();
  let started = startupCompleted;
  const lifecycle = registerReconnectReplayHandlers({ client, context, readiness, wakeScheduler: wake,
    isStartupCompleted: () => started, bootId: "test-boot" });
  return { client, context, readiness, wake, lifecycle, listeners,
    completeStartup: () => { started = true; lifecycle.completeStartup(); },
    emit: (event: "shardReady" | "shardResume" | "shardDisconnect") => {
      const listener = listeners.get(event); if (!listener) { throw new Error(`Missing ${event} handler`); } listener();
    }
  };
};

describe("reconnect readiness event control", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(epoch);
    vi.mocked(runReconciler).mockReset().mockReturnValue(Effect.succeed(report));
    vi.mocked(runStartupRecovery).mockReset().mockReturnValue(Effect.succeed(recovered));
    vi.spyOn(logger, "info").mockImplementation(() => undefined);
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.useRealTimers(); });

  it("does not start deferred replay work when stopped immediately after a Gateway event", async () => {
    const harness = createHarness();
    harness.emit("shardReady");
    harness.lifecycle.stop();
    await harness.lifecycle.drain();
    expect(runStartupRecovery).not.toHaveBeenCalled();
    expect(runReconciler).not.toHaveBeenCalled();
    expect(harness.wake).not.toHaveBeenCalled();
    expect(harness.readiness.state).toStrictEqual({ ready: false, reason: "shutting_down" });
    expect(harness.listeners.size).toBe(0);
  });

  it.each(["recovery", "reconcile"] as const)("stops replay admission during %s and drains without starting another phase", async phase => {
    const reconcile = deferred<typeof report>();
    const recovery = deferred<typeof recovered>();
    if (phase === "reconcile") { vi.mocked(runReconciler).mockReturnValueOnce(fromDatabaseCall(() => reconcile.promise, "reconcile")); }
    else { vi.mocked(runStartupRecovery).mockReturnValueOnce(fromDatabaseCall(() => recovery.promise, "recovery")); }
    const harness = createHarness(); harness.emit("shardReady"); await setImmediate();
    harness.lifecycle.stop(); let drained = false;
    const drain = harness.lifecycle.drain().then(() => { drained = true; return undefined; }); await setImmediate();
    try { expect(drained).toBe(false); expect(harness.listeners.size).toBe(0); }
    finally { reconcile.resolve(report); recovery.resolve(recovered); await drain; }
    expect(harness.readiness.state).toStrictEqual({ ready: false, reason: "shutting_down" });
    expect(runStartupRecovery).toHaveBeenCalledOnce();
    expect(runReconciler).toHaveBeenCalledTimes(phase === "reconcile" ? 1 : 0);
    expect(harness.wake).not.toHaveBeenCalled();
  });

  it("ignores shard events during initial startup", async () => {
    const harness = createHarness(false); harness.emit("shardDisconnect"); harness.emit("shardReady"); await setImmediate();
    expect(harness.readiness.state).toStrictEqual({ ready: false, reason: "startup" });
    expect(runReconciler).not.toHaveBeenCalled(); expect(runStartupRecovery).not.toHaveBeenCalled(); expect(harness.wake).not.toHaveBeenCalled();
    harness.completeStartup(); harness.emit("shardDisconnect");
    expect(harness.readiness.state).toStrictEqual({ ready: false, reason: "reconnecting" });
  });

  it("keeps a connection lost during startup unready until it resumes", async () => {
    const harness = createHarness(false);
    harness.emit("shardReady"); harness.emit("shardDisconnect"); harness.completeStartup();
    expect(harness.readiness.state).toStrictEqual({ ready: false, reason: "reconnecting" });
    expect(runReconciler).not.toHaveBeenCalled();
    harness.emit("shardResume"); await harness.lifecycle.drain();
    expect(harness.readiness.state).toStrictEqual({ ready: true, reason: undefined });
    expect(harness.wake).toHaveBeenCalledExactlyOnceWith("reconnect_replay");
    harness.lifecycle.stop();
  });

  it("recovers readiness after a disconnected Gateway session resumes", async () => {
    const harness = createHarness(); harness.completeStartup(); harness.emit("shardDisconnect"); harness.emit("shardResume");
    await setImmediate();
    expect(runReconciler).toHaveBeenCalledExactlyOnceWith(harness.client, harness.context, { scope: "reconnect" });
    expect(harness.wake).toHaveBeenCalledExactlyOnceWith("reconnect_replay");
    expect(harness.readiness.state).toStrictEqual({ ready: true, reason: undefined });
  });

  it.each(["success", "failure"] as const)("keeps readiness false if disconnected during replay %s", async outcome => {
    const reconcile = deferred<typeof report>();
    vi.mocked(runReconciler).mockReturnValueOnce(fromDatabaseCall(() => reconcile.promise, "reconcile"));
    const harness = createHarness(); harness.emit("shardReady"); await setImmediate(); harness.emit("shardDisconnect");
    if (outcome === "success") { reconcile.resolve(report); } else { reconcile.reject(new Error("disconnected")); }
    await setImmediate();
    expect(harness.readiness.state).toStrictEqual({ ready: false, reason: "reconnecting" });
    expect(runReconciler).toHaveBeenCalledOnce();
    harness.emit("shardReady"); await setImmediate();
    expect(runReconciler).toHaveBeenCalledTimes(2);
    expect(harness.readiness.state.ready).toBe(true);
  });

  it.each(["success", "failure"] as const)("retains a resumed connection while an earlier replay ends in %s", async outcome => {
    const first = deferred<typeof report>(); const second = deferred<typeof report>();
    vi.mocked(runReconciler)
      .mockReturnValueOnce(fromDatabaseCall(() => first.promise, "first"))
      .mockReturnValueOnce(fromDatabaseCall(() => second.promise, "second"));
    const harness = createHarness(); harness.emit("shardReady"); await setImmediate();
    harness.emit("shardDisconnect"); harness.emit("shardResume");
    expect(runReconciler).toHaveBeenCalledOnce();
    if (outcome === "success") { first.resolve(report); } else { first.reject(new Error("disconnected")); }
    await setImmediate();
    expect(runReconciler).toHaveBeenCalledTimes(2);
    expect(harness.readiness.state).toStrictEqual({ ready: false, reason: "replaying" });
    second.resolve(report); await setImmediate();
    expect(harness.readiness.state).toStrictEqual({ ready: true, reason: undefined });
  });

  it("waits for recovery then reconcile, rejects overlapping replay and wakes before readiness", async () => {
    const reconcile = deferred<typeof report>(); const recovery = deferred<typeof recovered>();
    vi.mocked(runReconciler).mockReturnValue(fromDatabaseCall(() => reconcile.promise, "reconcile"));
    vi.mocked(runStartupRecovery).mockReturnValue(fromDatabaseCall(() => recovery.promise, "recovery"));
    const harness = createHarness();
    harness.wake.mockImplementation(() => { expect(harness.readiness.state.ready).toBe(false); });
    harness.emit("shardReady"); harness.emit("shardReady"); await setImmediate();
    expect(harness.readiness.state).toStrictEqual({ ready: false, reason: "replaying" });
    expect(runStartupRecovery).toHaveBeenCalledExactlyOnceWith(harness.client, harness.context);
    expect(runReconciler).not.toHaveBeenCalled(); expect(harness.wake).not.toHaveBeenCalled();
    recovery.resolve(recovered); await setImmediate();
    expect(runReconciler).toHaveBeenCalledExactlyOnceWith(harness.client, harness.context, { scope: "reconnect" });
    expect(harness.wake).not.toHaveBeenCalled(); expect(harness.readiness.state.ready).toBe(false);
    harness.emit("shardReady"); reconcile.resolve(report); await setImmediate();
    expect(runReconciler).toHaveBeenCalledOnce(); expect(harness.wake).toHaveBeenCalledExactlyOnceWith("reconnect_replay");
    expect(harness.readiness.state).toStrictEqual({ ready: true, reason: undefined });
  });

  it("debounces from successful completion and replays at the exact boundary", async () => {
    const reconcile = deferred<typeof report>();
    vi.mocked(runReconciler).mockReturnValueOnce(fromDatabaseCall(() => reconcile.promise, "reconcile"));
    const harness = createHarness(); harness.emit("shardReady"); await setImmediate();
    vi.setSystemTime(epoch + 1_000); reconcile.resolve(report); await setImmediate();
    vi.setSystemTime(epoch + 1_000 + RECONNECT_REPLAY_DEBOUNCE_MS - 1);
    harness.emit("shardDisconnect"); harness.emit("shardReady"); await setImmediate();
    expect(runReconciler).toHaveBeenCalledOnce(); expect(harness.readiness.state.ready).toBe(true);
    vi.setSystemTime(epoch + 1_000 + RECONNECT_REPLAY_DEBOUNCE_MS);
    harness.emit("shardReady"); await setImmediate();
    expect(runReconciler).toHaveBeenCalledTimes(2); expect(harness.wake).toHaveBeenCalledTimes(2);
  });

  it.each(["reconcile", "recovery", "synchronous throw"] as const)("releases the in-flight lock and does not debounce after %s failure", async phase => {
    const error = new DatabaseError("replay failed");
    if (phase === "reconcile") { vi.mocked(runReconciler).mockReturnValueOnce(Effect.fail(error)); }
    if (phase === "recovery") { vi.mocked(runStartupRecovery).mockReturnValueOnce(Effect.fail(error)); }
    if (phase === "synchronous throw") { vi.mocked(runReconciler).mockImplementationOnce(() => { throw error; }); }
    const harness = createHarness(); harness.emit("shardReady"); await setImmediate();
    expect(harness.readiness.state).toStrictEqual({ ready: true, reason: undefined });
    expect(harness.wake).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ event: "reconnect.replay_failed", error }), "Reconnect replay failed.");
    harness.emit("shardReady"); await setImmediate();
    expect(runReconciler).toHaveBeenCalledTimes(phase === "recovery" ? 1 : 2);
    expect(harness.wake).toHaveBeenCalledExactlyOnceWith("reconnect_replay");
  });
});
