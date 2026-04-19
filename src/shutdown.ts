import { logger } from "./logger.js";

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
  if (!beginShutdown()) {
    logger.info({ signal: deps.signal }, "Shutdown already in progress.");
    return false;
  }

  logger.info({ signal: deps.signal }, "Shutdown started.");
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
