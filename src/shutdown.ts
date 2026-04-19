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

export const shutdownGracefully = async (deps: ShutdownDeps): Promise<boolean> => {
  // idempotent: SIGINT + SIGTERM 連続受信や重複発火でも 1 回だけ shutdown を走らせる。
  if (!beginShutdown()) {
    logger.info({ signal: deps.signal }, "Shutdown already in progress.");
    return false;
  }

  logger.info({ signal: deps.signal }, "Shutdown started.");
  // why: 先に scheduler を停止してから in-flight を待つ。この順序を逆にすると
  //   waitForInFlightSend 中に新たな cron tick が起動して in-flight が積み増される。
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
