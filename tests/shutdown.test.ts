import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetShutdownStateForTest,
  isShuttingDown,
  shutdownGracefully
} from "../src/shutdown.js";

describe("shutdown", () => {
  beforeEach(() => {
    __resetShutdownStateForTest();
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
