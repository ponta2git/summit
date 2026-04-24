import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import { TICK_DURATION_WARN_MS } from "../../src/config.js";
import { createTickSafetyWrap, runTickSafely } from "../../src/scheduler/tickRunner.js";
import { callArg } from "../helpers/assertions.js";

const makeLogger = () => {
  const info = vi.fn();
  const warn = vi.fn();
  const error = vi.fn();
  return { info, warn, error };
};

const asLogger = (logger: ReturnType<typeof makeLogger>): Logger =>
  logger as unknown as Logger;

const loggedEvents = (method: ReturnType<typeof vi.fn>) =>
  method.mock.calls.map((call) => (call[0] as { event?: string }).event);

describe("runTickSafely", () => {
  it("logs tick_started and tick_finished on success, no error log", async () => {
    const logger = makeLogger();

    await runTickSafely({ name: "testTick", logger: asLogger(logger) }, async () => {});

    expect(loggedEvents(logger.info)).toStrictEqual([
      "scheduler.tick_started",
      "scheduler.tick_finished"
    ]);
    expect(callArg<{ tick: string }>(logger.info).tick).toBe("testTick");
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("logs tick_failed on throw and resolves without re-throwing", async () => {
    const logger = makeLogger();
    const err = new Error("boom");

    await expect(
      runTickSafely({ name: "failTick", logger: asLogger(logger) }, async () => {
        throw err;
      })
    ).resolves.toBeUndefined();

    const errorFields = callArg<{ event: string; tick: string; err: Error }>(logger.error);
    expect({ event: errorFields.event, tick: errorFields.tick, err: errorFields.err }).toStrictEqual({
      event: "scheduler.tick_failed",
      tick: "failTick",
      err
    });
    expect(loggedEvents(logger.info)).toStrictEqual(["scheduler.tick_started"]);
  });

  it("logs tick_slow at warn level when elapsed exceeds TICK_DURATION_WARN_MS", async () => {
    const logger = makeLogger();
    // regression: nowFn injection ensures the slow-threshold test is deterministic without fake timers.
    let callCount = 0;
    const nowFn = (): number => {
      callCount++;
      return callCount === 1 ? 0 : TICK_DURATION_WARN_MS + 1;
    };

    await runTickSafely({ name: "slowTick", logger: asLogger(logger), nowFn }, async () => {});

    const warnFields = callArg<{ event: string; tick: string }>(logger.warn);
    expect({ event: warnFields.event, tick: warnFields.tick }).toStrictEqual({
      event: "scheduler.tick_slow",
      tick: "slowTick"
    });
    expect(loggedEvents(logger.info)).toStrictEqual([
      "scheduler.tick_started",
      "scheduler.tick_finished"
    ]);
  });

  it("does not log tick_slow when elapsed is within threshold", async () => {
    const logger = makeLogger();
    const nowFn = (): number => 0;

    await runTickSafely({ name: "fastTick", logger: asLogger(logger), nowFn }, async () => {});

    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("createTickSafetyWrap", () => {
  it("returns a function that delegates to runTickSafely with the bound logger", async () => {
    const logger = makeLogger();
    const safeWrap = createTickSafetyWrap(asLogger(logger));

    await safeWrap("wrappedTick", async () => {});

    expect(loggedEvents(logger.info)).toStrictEqual([
      "scheduler.tick_started",
      "scheduler.tick_finished"
    ]);
    expect(callArg<{ tick: string }>(logger.info).tick).toBe("wrappedTick");
  });
});
