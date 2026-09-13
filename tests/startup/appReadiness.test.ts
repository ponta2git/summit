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
  const client = asDiscordClient({ on: (event: string, callback: () => void) => { listeners.set(event, callback); } });
  const context = createTestAppContext(); const readiness = createAppReadiness(); const wake = vi.fn();
  let started = startupCompleted;
  registerReconnectReplayHandlers({ client, context, readiness, wakeScheduler: wake,
    isStartupCompleted: () => started, bootId: "test-boot" });
  return { client, context, readiness, wake,
    completeStartup: () => { started = true; readiness.markReady(); },
    emit: (event: "shardReady" | "shardDisconnect") => {
      const listener = listeners.get(event); if (!listener) { throw new Error(`Missing ${event} handler`); } listener();
    }
  };
};

describe("reconnect readiness event control", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(epoch);
    vi.mocked(runReconciler).mockReturnValue(okAsync(report));
    vi.mocked(runStartupRecovery).mockReturnValue(okAsync(recovered));
    vi.spyOn(logger, "info").mockImplementation(() => undefined);
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.useRealTimers(); });

  it("ignores shard events during initial startup", async () => {
    const h = createHarness(false); h.emit("shardDisconnect"); h.emit("shardReady"); await setImmediate();
    expect(h.readiness.state).toStrictEqual({ ready: false, reason: "startup" });
    expect(runReconciler).not.toHaveBeenCalled(); expect(runStartupRecovery).not.toHaveBeenCalled(); expect(h.wake).not.toHaveBeenCalled();
    h.completeStartup(); h.emit("shardDisconnect");
    expect(h.readiness.state).toStrictEqual({ ready: false, reason: "reconnecting" });
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
