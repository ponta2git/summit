import { logger } from "./logger.js";

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
  // invariant: scheduler 停止 → in-flight 待機の順序。逆にすると cron tick が in-flight を積み増す。
  deps.stopScheduler();

  try {
    await deps.waitForInFlightSend();
  } catch (error: unknown) {
    logger.error({ error, signal: deps.signal }, "Waiting in-flight send failed during shutdown.");
  }

  try {
    await deps.closeDb();
  } catch (error: unknown) {
    logger.error({ error, signal: deps.signal }, "Database close failed during shutdown.");
  }

  try {
    deps.destroyClient();
  } catch (error: unknown) {
    logger.error({ error, signal: deps.signal }, "Discord client destroy failed during shutdown.");
  }

  logger.info({ signal: deps.signal }, "Shutdown completed.");
  return true;
};

export const __resetShutdownStateForTest = (): void => {
  shuttingDown = false;
};
