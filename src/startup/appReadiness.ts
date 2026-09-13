import type { Client } from "discord.js";

import type { AppContext } from "../appContext.ts";
import type { AppReadyState } from "../discord/shared/dispatcher.ts";
import { logger } from "../logger.ts";
import { RECONNECT_REPLAY_DEBOUNCE_MS } from "../config.ts";
import { runReconciler } from "../scheduler/reconciler.ts";
import { runStartupRecovery } from "../scheduler/index.ts";
import { unwrapResultAsync } from "../errors/result.ts";

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
  readonly wakeScheduler?: (reason: string) => void;
}): void => {
  const { client, context, readiness, isStartupCompleted, bootId } = input;
  // why: reconnect 時に reconciler + startupRecovery を replay し disconnect 中の cron 副作用漏れを収束させる。
  // race: in-flight Promise lock + 時刻 debounce で flappy reconnect を直列化する。
  // ack: replay 中は readiness で dispatcher に load-shed させ interaction を ephemeral で却下。
  let replayInFlight: Promise<void> | undefined;
  let lastReplaySucceededAt: number | undefined;
  let connected = false;
  let connectionVersion = 0;

  const triggerReconnectReplay = (connectionChangedDuringReplay = false): void => {
    if (!isStartupCompleted()) {
      return;
    }
    if (replayInFlight) {
      return;
    }
    const now = Date.now();
    if (!connectionChangedDuringReplay && lastReplaySucceededAt !== undefined && now - lastReplaySucceededAt < RECONNECT_REPLAY_DEBOUNCE_MS) {
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
    const replayVersion = connectionVersion;
    const startedAt = Date.now();
    logger.info(
      { event: "reconnect.replay_start", bootId },
      "Reconnect replay started."
    );
    // race: 同期throwでもfinallyより先にPromiseを登録し、完了済みlockを残さない。
    replayInFlight = (async () => {
      await Promise.resolve();
      try {
        const report = await unwrapResultAsync(runReconciler(client, context, { scope: "reconnect" }));
        await unwrapResultAsync(runStartupRecovery(client, context));
        input.wakeScheduler?.("reconnect_replay");
        const completedAt = Date.now();
        if (connected && replayVersion === connectionVersion) {
          lastReplaySucceededAt = completedAt;
        }
        logger.info(
          {
            event: "reconnect.replay_done",
            bootId,
            elapsedMs: completedAt - startedAt,
            cancelledPromoted: report.cancelledPromoted,
            askCreated: report.askCreated,
            messageIntentsQueued: report.messageIntentsQueued,
            outboxClaimReleased: report.outboxClaimReleased,
            outboxDeadLettersRequeued: report.outboxDeadLettersRequeued,
            outboxSuccessorsRequeued: report.outboxSuccessorsRequeued
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
        if (!connected) {
          readiness.markNotReady("reconnecting");
        } else if (replayVersion !== connectionVersion) {
          // race: 処理中に切断・再接続した世代を、旧 replay の成功 debounce で落とさない。
          triggerReconnectReplay(true);
        } else {
          // idempotent: 接続中の失敗は次の scheduler tick で収束できる。
          readiness.markReady();
        }
      }
    })();
  };

  client.on("shardDisconnect", () => {
    connected = false;
    connectionVersion += 1;
    if (!isStartupCompleted()) {
      return;
    }
    readiness.markNotReady("reconnecting");
  });

  const onConnected = (): void => {
    connected = true;
    triggerReconnectReplay();
  };
  client.on("shardReady", onConnected);
  client.on("shardResume", onConnected);
};
