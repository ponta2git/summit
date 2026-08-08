import type { Logger } from "pino";
import type { ResultAsync } from "neverthrow";

import { TICK_DURATION_WARN_MS } from "../config.ts";
import { AppError, type AppError as AppErrorType } from "../errors/index.ts";

export interface RunTickSafelyOptions {
  readonly name: string;
  readonly logger: Pick<Logger, "error" | "info" | "warn">;
  readonly nowFn?: () => number;
}

/**
 * Wraps an async cron tick with structured logging and failure isolation.
 *
 * @remarks
 * idempotent: tick 内の例外を外に漏らさず次 tick で再計算して冪等回復する。
 * Logs `scheduler.tick_started/finished/failed` and `scheduler.tick_slow` when
 * `elapsedMs` exceeds `TICK_DURATION_WARN_MS` (src/config.ts).
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
      logger.warn({ event: "scheduler.tick_slow", tick: name, elapsedMs });
    }
  } catch (err: unknown) {
    const elapsedMs = nowFn() - start;
    logger.error({
      event: "scheduler.tick_failed",
      tick: name,
      elapsedMs,
      err,
      ...(err instanceof AppError ? { errorCode: err.code } : {})
    });
  }
};

export const runResultTickSafely = async <T>(
  options: RunTickSafelyOptions,
  fn: () => ResultAsync<T, AppErrorType>,
  onSuccess?: (value: T) => void | Promise<void>
): Promise<void> => {
  await runTickSafely(options, async () => {
    const value = await fn().match(
      (result) => result,
      (error) => {
        throw error;
      }
    );
    await onSuccess?.(value);
  });
};
