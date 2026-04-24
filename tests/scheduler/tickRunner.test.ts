import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import { TICK_DURATION_WARN_MS } from "../../src/config.js";
import { createTickSafetyWrap, runTickSafely } from "../../src/scheduler/tickRunner.js";

const makeLogger = () => {
  const info = vi.fn();
  const warn = vi.fn();
  const error = vi.fn();
  return { info, warn, error } as unknown as Logger;
};

describe("runTickSafely", () => {
  it("logs tick_started and tick_finished on success, no error log", async () => {
    const logger = makeLogger();

    await runTickSafely({ name: "testTick", logger }, async () => {});

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "scheduler.tick_started", tick: "testTick" })
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "scheduler.tick_finished", tick: "testTick" })
    );
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("logs tick_failed on throw and resolves without re-throwing", async () => {
    const logger = makeLogger();
    const err = new Error("boom");

    await expect(
      runTickSafely({ name: "failTick", logger }, async () => {
        throw err;
      })
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: "scheduler.tick_failed", tick: "failTick", err })
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "scheduler.tick_started", tick: "failTick" })
    );
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "scheduler.tick_finished" })
    );
  });

  it("logs tick_slow at warn level when elapsed exceeds TICK_DURATION_WARN_MS", async () => {
    const logger = makeLogger();
    // regression: nowFn injection ensures the slow-threshold test is deterministic without fake timers.
    let callCount = 0;
    const nowFn = (): number => {
      callCount++;
      return callCount === 1 ? 0 : TICK_DURATION_WARN_MS + 1;
    };

    await runTickSafely({ name: "slowTick", logger, nowFn }, async () => {});

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "scheduler.tick_slow", tick: "slowTick" })
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "scheduler.tick_finished", tick: "slowTick" })
    );
  });

  it("does not log tick_slow when elapsed is within threshold", async () => {
    const logger = makeLogger();
    const nowFn = (): number => 0;

    await runTickSafely({ name: "fastTick", logger, nowFn }, async () => {});

    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("createTickSafetyWrap", () => {
  it("returns a function that delegates to runTickSafely with the bound logger", async () => {
    const logger = makeLogger();
    const safeWrap = createTickSafetyWrap(logger);

    await safeWrap("wrappedTick", async () => {});

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "scheduler.tick_started", tick: "wrappedTick" })
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "scheduler.tick_finished", tick: "wrappedTick" })
    );
  });
});
