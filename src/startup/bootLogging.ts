import { logger } from "../logger.js";

export type BootPhase = "boot_start" | "db_connect" | "reconcile" | "login" | "ready";

export const createBootPhaseLogger = (
  bootId: string,
  bootStartedAt: number
): ((phase: BootPhase, extra?: Record<string, unknown>) => void) =>
  (phase, extra = {}) => {
    logger.info(
      {
        event: "boot.phase",
        phase,
        bootId,
        elapsedMs: Date.now() - bootStartedAt,
        ...extra
      },
      `Boot phase: ${phase}.`
    );
  };
