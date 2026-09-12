import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SHUTDOWN_DRAIN_TIMEOUT_MS } from "../src/config.ts";

import {
  isShuttingDown,
  resetShutdownStateForTest,
  shutdownGracefully
} from "../src/shutdown.js";

describe("shutdown", () => {
  beforeEach(() => {
    resetShutdownStateForTest();
  });
  afterEach(() => { vi.useRealTimers(); });

  it("stops new work before draining, then closes resources at the deadline if delivery hangs", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const completion = shutdownGracefully({ signal: "SIGTERM",
      stopScheduler: () => { order.push("stop"); },
      waitForInFlightSend: async () => { order.push("drain"); await new Promise<void>(() => undefined); },
      closeDb: async () => { order.push("database"); },
      destroyClient: () => { order.push("discord"); }
    });
    await vi.advanceTimersByTimeAsync(SHUTDOWN_DRAIN_TIMEOUT_MS - 1);
    expect(order).toEqual(["stop", "drain"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await completion).toBe(true);
    expect(order).toEqual(["stop", "drain", "database", "discord"]);
  });

  it("runs shutdown sequence once and ignores duplicate signals", async () => {
    const stopScheduler = vi.fn();
    const waitForInFlightSend = vi.fn(async () => undefined);
    const closeDb = vi.fn(async () => undefined);
    const destroyClient = vi.fn();

    const first = await shutdownGracefully({
      signal: "SIGTERM",
      stopScheduler,
      waitForInFlightSend,
      closeDb,
      destroyClient
    });

    const second = await shutdownGracefully({
      signal: "SIGTERM",
      stopScheduler,
      waitForInFlightSend,
      closeDb,
      destroyClient
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(isShuttingDown()).toBe(true);
    expect(stopScheduler).toHaveBeenCalledTimes(1);
    expect(waitForInFlightSend).toHaveBeenCalledTimes(1);
    expect(closeDb).toHaveBeenCalledTimes(1);
    expect(destroyClient).toHaveBeenCalledTimes(1);
  });

  it("continues shutdown even when waiting in-flight send fails", async () => {
    const stopScheduler = vi.fn();
    const waitForInFlightSend = vi.fn(async () => {
      throw new Error("failed to drain");
    });
    const closeDb = vi.fn(async () => undefined);
    const destroyClient = vi.fn();

    const started = await shutdownGracefully({
      signal: "SIGINT",
      stopScheduler,
      waitForInFlightSend,
      closeDb,
      destroyClient
    });

    expect(started).toBe(true);
    expect(closeDb).toHaveBeenCalledTimes(1);
    expect(destroyClient).toHaveBeenCalledTimes(1);
  });
});
