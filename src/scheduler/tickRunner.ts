// Wire via a follow-up commit that wraps each cron callback in `runTickSafely(...)`.
// Each registered tick in createAskScheduler (scheduler/index.ts) should become:
//   () => void runTickSafely({ name: "<tick-name>", logger }, () => runXxxTick(...))

import type { Logger } from "pino";

import { TICK_DURATION_WARN_MS } from "../config.js";

export interface RunTickSafelyOptions {
  readonly name: string;
  readonly logger: Logger;
  /** Injectable clock for testing; defaults to `performance.now`. */
  readonly nowFn?: () => number;
}

/**
 * Wraps an async cron tick function with structured logging and failure isolation.
 *
 * @remarks
 * - Logs `scheduler.tick_started` / `scheduler.tick_finished` on the happy path.
 * - Catches all errors, logs `scheduler.tick_failed` with `elapsedMs` and `err`, never re-throws.
 * - Logs `scheduler.tick_slow` at warn level when `elapsedMs` exceeds `TICK_DURATION_WARN_MS`.
 * @see src/config.ts TICK_DURATION_WARN_MS
 */
export const runTickSafely = async (
  options: RunTickSafelyOptions,
  fn: () => Promise<void>
): Promise<void> => {
  const { name, logger, nowFn = () => performance.now() } = options;

  const start = nowFn();
  logger.info({ event: "scheduler.tick_started", tick: name });

  try {
    await fn();
    const elapsedMs = nowFn() - start;
    logger.info({ event: "scheduler.tick_finished", tick: name, elapsedMs });
    if (elapsedMs > TICK_DURATION_WARN_MS) {
      // why: 次 tick と noOverlap で競合する前に長時間 tick を検知する。
      logger.warn({ event: "scheduler.tick_slow", tick: name, elapsedMs });
    }
  } catch (err: unknown) {
    const elapsedMs = nowFn() - start;
    // why: cron tick の例外を外に漏らさない。次 tick で再計算して冪等回復する (AGENTS.md §落とし穴 5)。
    logger.error({ event: "scheduler.tick_failed", tick: name, elapsedMs, err });
  }
};

/**
 * Factory that partially applies a logger so call sites only need `(name, fn)`.
 *
 * @example
 * ```ts
 * const safeWrap = createTickSafetyWrap(logger);
 * safeWrap("deadline", () => runDeadlineTick(client, ctx));
 * ```
 */
export const createTickSafetyWrap =
  (logger: Logger) =>
  (name: string, fn: () => Promise<void>): Promise<void> =>
    runTickSafely({ name, logger }, fn);
