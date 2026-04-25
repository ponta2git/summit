import type { Client } from "discord.js";

import type { AppContext } from "../appContext.js";
import type { AppReadyState } from "../discord/shared/dispatcher.js";
import { logger } from "../logger.js";
import { RECONNECT_REPLAY_DEBOUNCE_MS } from "../config.js";
import { runReconciler } from "../scheduler/reconciler.js";
import { runStartupRecovery } from "../scheduler/index.js";

export interface AppReadiness {
  readonly state: AppReadyState;
  markReady(): void;
  markNotReady(reason: string): void;
}

export const createAppReadiness = (): AppReadiness => {
  const state: AppReadyState = {
    ready: false,
    reason: "startup"
  };

  return {
    state,
    markReady: () => {
      state.ready = true;
      state.reason = undefined;
    },
    markNotReady: (reason) => {
      state.ready = false;
      state.reason = reason;
    }
  };
};

export const registerReconnectReplayHandlers = (input: {
  readonly client: Client;
  readonly context: AppContext;
  readonly readiness: AppReadiness;
  readonly isStartupCompleted: () => boolean;
  readonly bootId: string;
}): void => {
  const { client, context, readiness, isStartupCompleted, bootId } = input;
  // why: reconnect 時に reconciler + startupRecovery を replay し disconnect 中の cron 副作用漏れを収束させる。
  // race: in-flight Promise lock + 時刻 debounce で flappy reconnect を直列化する。
  // ack: replay 中は readiness で dispatcher に load-shed させ interaction を ephemeral で却下。
  let replayInFlight: Promise<void> | undefined;
  let lastReplaySucceededAt = 0;

  const triggerReconnectReplay = (): void => {
    if (!isStartupCompleted()) {
      return;
    }
    if (replayInFlight) {
      return;
    }
    const now = Date.now();
    if (now - lastReplaySucceededAt < RECONNECT_REPLAY_DEBOUNCE_MS) {
      readiness.markReady();
      logger.info(
        {
          event: "reconnect.replay_skipped",
          bootId,
          reason: "debounced",
          sinceLastMs: now - lastReplaySucceededAt
        },
        "Reconnect replay skipped (debounced)."
      );
      return;
    }

    readiness.markNotReady("replaying");
    const startedAt = Date.now();
    logger.info(
      { event: "reconnect.replay_start", bootId },
      "Reconnect replay started."
    );
    replayInFlight = (async () => {
      try {
        const report = await runReconciler(client, context, { scope: "reconnect" });
        await runStartupRecovery(client, context);
        lastReplaySucceededAt = Date.now();
        logger.info(
          {
            event: "reconnect.replay_done",
            bootId,
            elapsedMs: lastReplaySucceededAt - startedAt,
            cancelledPromoted: report.cancelledPromoted,
            askCreated: report.askCreated,
            messageResent: report.messageResent,
            staleClaimReclaimed: report.staleClaimReclaimed,
            outboxClaimReleased: report.outboxClaimReleased
          },
          "Reconnect replay completed."
        );
      } catch (error: unknown) {
        logger.error(
          {
            event: "reconnect.replay_failed",
            bootId,
            elapsedMs: Date.now() - startedAt,
            error
          },
          "Reconnect replay failed."
        );
      } finally {
        replayInFlight = undefined;
        // idempotent: 成否に関わらず ready に戻す。失敗時も次 scheduler tick で再収束する。
        readiness.markReady();
      }
    })();
  };

  client.on("shardDisconnect", () => {
    if (!isStartupCompleted()) {
      return;
    }
    readiness.markNotReady("reconnecting");
  });

  client.on("shardReady", () => {
    triggerReconnectReplay();
  });
};
