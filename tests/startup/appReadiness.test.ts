import { setImmediate } from "node:timers/promises";
import { ResultAsync, errAsync, okAsync } from "neverthrow";
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
    vi.mocked(runReconciler).mockReset().mockReturnValue(okAsync(report));
    vi.mocked(runStartupRecovery).mockReset().mockReturnValue(okAsync(recovered));
    vi.spyOn(logger, "info").mockImplementation(() => undefined);
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.useRealTimers(); });

  it("stops replay admission and drains current work without starting another recovery phase", async () => {
    const reconcile = deferred<typeof report>();
    vi.mocked(runReconciler).mockReturnValueOnce(ResultAsync.fromPromise(reconcile.promise, cause => new DatabaseError("reconcile", { cause })));
    const h = createHarness(); h.emit("shardReady"); await setImmediate();
    h.lifecycle.stop(); let drained = false;
    const drain = h.lifecycle.drain().then(() => { drained = true; return undefined; }); await setImmediate();
    try { expect(drained).toBe(false); expect(h.listeners.size).toBe(0); }
    finally { reconcile.resolve(report); await drain; }
    expect(h.readiness.state).toStrictEqual({ ready: false, reason: "shutting_down" });
    expect(runStartupRecovery).not.toHaveBeenCalled(); expect(h.wake).not.toHaveBeenCalled();
  });

  it("ignores shard events during initial startup", async () => {
    const h = createHarness(false); h.emit("shardDisconnect"); h.emit("shardReady"); await setImmediate();
    expect(h.readiness.state).toStrictEqual({ ready: false, reason: "startup" });
    expect(runReconciler).not.toHaveBeenCalled(); expect(runStartupRecovery).not.toHaveBeenCalled(); expect(h.wake).not.toHaveBeenCalled();
    h.completeStartup(); h.emit("shardDisconnect");
    expect(h.readiness.state).toStrictEqual({ ready: false, reason: "reconnecting" });
  });

  it("keeps a connection lost during startup unready until it resumes", async () => {
    const h = createHarness(false);
    h.emit("shardReady"); h.emit("shardDisconnect"); h.completeStartup();
    expect(h.readiness.state).toStrictEqual({ ready: false, reason: "reconnecting" });
    expect(runReconciler).not.toHaveBeenCalled();
    h.emit("shardResume"); await h.lifecycle.drain();
    expect(h.readiness.state).toStrictEqual({ ready: true, reason: undefined });
    expect(h.wake).toHaveBeenCalledExactlyOnceWith("reconnect_replay");
    h.lifecycle.stop();
  });

  it("recovers readiness after a disconnected Gateway session resumes", async () => {
    const h = createHarness(); h.completeStartup(); h.emit("shardDisconnect"); h.emit("shardResume");
    await setImmediate();
    expect(runReconciler).toHaveBeenCalledExactlyOnceWith(h.client, h.context, { scope: "reconnect" });
    expect(h.wake).toHaveBeenCalledExactlyOnceWith("reconnect_replay");
    expect(h.readiness.state).toStrictEqual({ ready: true, reason: undefined });
  });

  it.each(["success", "failure"] as const)("keeps readiness false if disconnected during replay %s", async outcome => {
    const reconcile = deferred<typeof report>();
    vi.mocked(runReconciler).mockReturnValueOnce(ResultAsync.fromPromise(reconcile.promise, cause => new DatabaseError("reconcile", { cause })));
    const h = createHarness(); h.emit("shardReady"); await setImmediate(); h.emit("shardDisconnect");
    if (outcome === "success") { reconcile.resolve(report); } else { reconcile.reject(new Error("disconnected")); }
    await setImmediate();
    expect(h.readiness.state).toStrictEqual({ ready: false, reason: "reconnecting" });
    expect(runReconciler).toHaveBeenCalledOnce();
    h.emit("shardReady"); await setImmediate();
    expect(runReconciler).toHaveBeenCalledTimes(2);
    expect(h.readiness.state.ready).toBe(true);
  });

  it.each(["success", "failure"] as const)("retains a resumed connection while an earlier replay ends in %s", async outcome => {
    const first = deferred<typeof report>(); const second = deferred<typeof report>();
    vi.mocked(runReconciler)
      .mockReturnValueOnce(ResultAsync.fromPromise(first.promise, cause => new DatabaseError("first", { cause })))
      .mockReturnValueOnce(ResultAsync.fromPromise(second.promise, cause => new DatabaseError("second", { cause })));
    const h = createHarness(); h.emit("shardReady"); await setImmediate();
    h.emit("shardDisconnect"); h.emit("shardResume");
    expect(runReconciler).toHaveBeenCalledOnce();
    if (outcome === "success") { first.resolve(report); } else { first.reject(new Error("disconnected")); }
    await setImmediate();
    expect(runReconciler).toHaveBeenCalledTimes(2);
    expect(h.readiness.state).toStrictEqual({ ready: false, reason: "replaying" });
    second.resolve(report); await setImmediate();
    expect(h.readiness.state).toStrictEqual({ ready: true, reason: undefined });
  });

  it("waits for reconcile then recovery, rejects overlapping replay and wakes before readiness", async () => {
    const reconcile = deferred<typeof report>(); const recovery = deferred<typeof recovered>();
    vi.mocked(runReconciler).mockReturnValue(ResultAsync.fromPromise(reconcile.promise, cause => new DatabaseError("reconcile", { cause })));
    vi.mocked(runStartupRecovery).mockReturnValue(ResultAsync.fromPromise(recovery.promise, cause => new DatabaseError("recovery", { cause })));
    const h = createHarness();
    h.wake.mockImplementation(() => { expect(h.readiness.state.ready).toBe(false); });
    h.emit("shardReady"); h.emit("shardReady"); await setImmediate();
    expect(h.readiness.state).toStrictEqual({ ready: false, reason: "replaying" });
    expect(runReconciler).toHaveBeenCalledExactlyOnceWith(h.client, h.context, { scope: "reconnect" });
    expect(runStartupRecovery).not.toHaveBeenCalled(); expect(h.wake).not.toHaveBeenCalled();
    reconcile.resolve(report); await setImmediate();
    expect(runStartupRecovery).toHaveBeenCalledExactlyOnceWith(h.client, h.context);
    expect(h.wake).not.toHaveBeenCalled(); expect(h.readiness.state.ready).toBe(false);
    h.emit("shardReady"); recovery.resolve(recovered); await setImmediate();
    expect(runReconciler).toHaveBeenCalledOnce(); expect(h.wake).toHaveBeenCalledExactlyOnceWith("reconnect_replay");
    expect(h.readiness.state).toStrictEqual({ ready: true, reason: undefined });
  });

  it("debounces from successful completion and replays at the exact boundary", async () => {
    const reconcile = deferred<typeof report>();
    vi.mocked(runReconciler).mockReturnValueOnce(ResultAsync.fromPromise(reconcile.promise, cause => new DatabaseError("reconcile", { cause })));
    const h = createHarness(); h.emit("shardReady"); await setImmediate();
    vi.setSystemTime(epoch + 1_000); reconcile.resolve(report); await setImmediate();
    vi.setSystemTime(epoch + 1_000 + RECONNECT_REPLAY_DEBOUNCE_MS - 1);
    h.emit("shardDisconnect"); h.emit("shardReady"); await setImmediate();
    expect(runReconciler).toHaveBeenCalledOnce(); expect(h.readiness.state.ready).toBe(true);
    vi.setSystemTime(epoch + 1_000 + RECONNECT_REPLAY_DEBOUNCE_MS);
    h.emit("shardReady"); await setImmediate();
    expect(runReconciler).toHaveBeenCalledTimes(2); expect(h.wake).toHaveBeenCalledTimes(2);
  });

  it.each(["reconcile", "recovery", "synchronous throw"] as const)("releases the in-flight lock and does not debounce after %s failure", async phase => {
    const error = new DatabaseError("replay failed");
    if (phase === "reconcile") { vi.mocked(runReconciler).mockReturnValueOnce(errAsync(error)); }
    if (phase === "recovery") { vi.mocked(runStartupRecovery).mockReturnValueOnce(errAsync(error)); }
    if (phase === "synchronous throw") { vi.mocked(runReconciler).mockImplementationOnce(() => { throw error; }); }
    const h = createHarness(); h.emit("shardReady"); await setImmediate();
    expect(h.readiness.state).toStrictEqual({ ready: true, reason: undefined });
    expect(h.wake).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ event: "reconnect.replay_failed", error }), "Reconnect replay failed.");
    h.emit("shardReady"); await setImmediate();
    expect(runReconciler).toHaveBeenCalledTimes(2);
    expect(h.wake).toHaveBeenCalledExactlyOnceWith("reconnect_replay");
  });
});
