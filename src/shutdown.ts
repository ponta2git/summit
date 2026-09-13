import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { promiseCall, runPromiseBoundary } from "./runtime/effect.ts";
import { logger } from "./logger.ts";
import { SHUTDOWN_DRAIN_TIMEOUT_MS } from "./config.ts";

// single-instance: プロセスローカルな shutdown フラグ。
//   isShuttingDown は sendAskMessage の入口で参照し、SIGTERM 後の新規送信を抑制する。
let shuttingDown = false;

export interface ShutdownDeps {
  signal: NodeJS.Signals;
  stopScheduler: () => void;
  waitForInFlightSend: () => Promise<void>;
  closeDb: () => Promise<void>;
  destroyClient: () => void;
}

export const isShuttingDown = (): boolean => shuttingDown;

const beginShutdown = (): boolean => {
  if (shuttingDown) {
    return false;
  }
  shuttingDown = true;
  return true;
};

/**
 * Gracefully tears down the Bot: scheduler → in-flight sends → DB → Discord client.
 *
 * @remarks
 * SIGINT / SIGTERM の連続受信でも 1 度だけ実行される（idempotent）。停止順序を逆にすると
 * 待機中の cron tick が in-flight を積み増すため、必ず scheduler を先に止めること。
 * @returns `true` if this invocation performed the shutdown, `false` if already in progress.
 */
export const shutdownGracefully = async (deps: ShutdownDeps): Promise<boolean> => {
  if (!beginShutdown()) {
    logger.info({ signal: deps.signal }, "Shutdown already in progress.");
    return false;
  }

  logger.info({ signal: deps.signal }, "Shutdown started.");
  const attempt = <T, E>(effect: Effect.Effect<T, E>, message: string): Effect.Effect<void> =>
    Effect.asVoid(Effect.catchAllCause(effect, cause => Effect.sync(() => {
      logger.error({ error: Cause.squash(cause), signal: deps.signal }, message);
    })));

  const closeResources = Effect.gen(function* () {
    yield* attempt(promiseCall(deps.closeDb), "Database close failed during shutdown.");
    yield* attempt(Effect.sync(deps.destroyClient), "Discord client destroy failed during shutdown.");
  });

  await runPromiseBoundary(Effect.gen(function* () {
    // invariant: stop admission before drain; a broken stop adapter must not bypass resource cleanup.
    yield* attempt(Effect.sync(deps.stopScheduler), "Stopping scheduler failed during shutdown.");
    yield* attempt(promiseCall(deps.waitForInFlightSend).pipe(
      // This bounds waiting only. Pending external I/O remains recoverable by its persisted claim.
      Effect.timeoutOption(SHUTDOWN_DRAIN_TIMEOUT_MS),
      Effect.tap(result => Effect.sync(() => {
        if (Option.isNone(result)) {
          logger.warn({ event: "shutdown.drain_timeout", signal: deps.signal }, "Pending notifications remain recoverable from DB.");
        }
      }))
    ), "Waiting in-flight send failed during shutdown.");
  }).pipe(Effect.ensuring(closeResources)));

  logger.info({ signal: deps.signal }, "Shutdown completed.");
  return true;
};

export const resetShutdownStateForTest = (): void => {
  shuttingDown = false;
};
