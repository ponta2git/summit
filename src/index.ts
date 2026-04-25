import { randomUUID } from "node:crypto";

import type { ScheduledTask } from "node-cron";
import { RESTEvents } from "discord.js";

import { createAppContext } from "./appContext.js";
import { closeDb, db } from "./db/client.js";
import { waitForInFlightSend } from "./features/ask-session/send.js";
import { createDiscordClient } from "./discord/client.js";
import { registerInteractionHandlers } from "./discord/index.js";
import type { AppReadyState } from "./discord/shared/dispatcher.js";
import { env } from "./env.js";
import { sendHealthcheckPing } from "./healthcheck/ping.js";
import { logger } from "./logger.js";
import { buildMemberReconcileInputs } from "./members/inputs.js";
import { reconcileMembers } from "./members/reconcile.js";
import { runReconciler } from "./scheduler/reconciler.js";
import { createAskScheduler, runStartupRecovery } from "./scheduler/index.js";
import { shutdownGracefully } from "./shutdown.js";
import { HEALTHCHECK_PING_TIMEOUT_MS, RECONNECT_REPLAY_DEBOUNCE_MS } from "./config.js";
import { appConfig } from "./userConfig.js";

const appContext = createAppContext();
const client = createDiscordClient();
const appReadyState: AppReadyState = {
  ready: false,
  reason: "startup"
};
let startupCompleted = false;

const markAppReady = (): void => {
  appReadyState.ready = true;
  appReadyState.reason = undefined;
};

const markAppNotReady = (reason: string): void => {
  appReadyState.ready = false;
  appReadyState.reason = reason;
};

client.on("shardDisconnect", () => {
  if (!startupCompleted) {
    return;
  }

  markAppNotReady("reconnecting");
});

// why: reconnect 時に reconciler + startupRecovery を replay し disconnect 中の cron 副作用漏れを収束させる → ADR-0036
// race: in-flight Promise lock + 時刻 debounce で flappy reconnect を直列化する。
// ack: replay 中は markAppNotReady で dispatcher に load-shed させ interaction を ephemeral で却下。
let replayInFlight: Promise<void> | undefined;
let lastReplaySucceededAt = 0;

const triggerReconnectReplay = (): void => {
  if (!startupCompleted) {
    return;
  }
  if (replayInFlight) {
    return;
  }
  const now = Date.now();
  if (now - lastReplaySucceededAt < RECONNECT_REPLAY_DEBOUNCE_MS) {
    markAppReady();
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

  markAppNotReady("replaying");
  const startedAt = Date.now();
  logger.info(
    { event: "reconnect.replay_start", bootId },
    "Reconnect replay started."
  );
  replayInFlight = (async () => {
    try {
      const report = await runReconciler(client, appContext, { scope: "reconnect" });
      await runStartupRecovery(client, appContext);
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
      markAppReady();
    }
  })();
};

client.on("shardReady", () => {
  if (!startupCompleted) {
    return;
  }

  triggerReconnectReplay();
});

registerInteractionHandlers(client, appContext, {
  getReadyState: () => appReadyState
});

// race: scheduler は runStartupRecovery 完了後に生成する。node-cron は schedule() 時点で
//   auto-start するため、top-level 生成すると startup recovery と reminder tick が並行し
//   DECIDED セッションへの二重送信 race を作る → ADR-0024
let scheduler: readonly ScheduledTask[] | undefined;

const handleShutdownSignal = (signal: NodeJS.Signals): void => {
  void shutdownGracefully({
    signal,
    stopScheduler: () => {
      if (!scheduler) {
        return;
      }
      for (const task of scheduler) {
        task.stop();
      }
    },
    waitForInFlightSend,
    closeDb,
    destroyClient: () => client.destroy()
  })
    .then((didStart) => {
      if (didStart) {
        process.exit(0);
      }
      return undefined;
    })
    .catch((error: unknown) => {
      logger.error({ error, signal }, "Fatal shutdown error.");
      process.exit(1);
    });
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  // idempotent: once で同一シグナルの多重発火を防ぐ。二重 shutdown は shutdownGracefully 側でもガード。
  process.once(signal, () => {
    handleShutdownSignal(signal);
  });
}

// why: 起動フェーズごとの構造化ログで「どこで止まったか」を診断可能にする。bootId はプロセス単位。
// @see ADR-0033
const bootId = randomUUID();
const bootStartedAt = Date.now();

const logBootPhase = (
  phase: "boot_start" | "db_connect" | "reconcile" | "login" | "ready",
  extra: Record<string, unknown> = {}
): void => {
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

const run = async (): Promise<void> => {
  logBootPhase("boot_start");

  // why: user config の member SSoT を起動時に DB へ反映。cron 登録・login より前に完了させる。
  await reconcileMembers(
    buildMemberReconcileInputs(appConfig.memberUserIds, appConfig.memberDisplayNames),
    db
  );
  logBootPhase("db_connect");

  await client.login(env.DISCORD_TOKEN);
  logBootPhase("login");

  // why: 429 の route/retryAfter を観測するため購読 → ADR-0019 (M11)
  client.rest.on(RESTEvents.RateLimited, (info) => {
    try {
      logger.warn({
        event: 'discord.rate_limited',
        route: info.route,
        method: info.method,
        majorParameter: info.majorParameter,
        retryAfter: info.retryAfter,
        limit: info.limit,
        timeToReset: info.timeToReset,
        globalLimit: info.global,
      }, 'Discord REST rate limit hit');
    } catch {
      // why: listener 内の例外を上位へ伝播させない（EventEmitter uncaught 回避）。
    }
  });

  // why: 本番 invariant (OFF) を覆している状態を起動時 1 回だけ warn で明示する → ADR-0011
  if (appConfig.dev.suppressMentions) {
    logger.warn(
      { devMentionSuppression: true, mentionSuppression: "client-default" },
      "Dev mention suppression is ON. Push mentions are suppressed and `<@id>` lines are omitted from message bodies."
    );
  }

  // source-of-truth: DB と Discord の invariant を収束させる (C1/N1/H1)。CAS 冪等のため scheduler との競合は race lost として扱う。
  // race: scheduler は本呼び出しの完了**後**に生成する（reminder claim revert 中の reminder tick は no-op 設計）。
  // @see ADR-0033
  const report = await runReconciler(client, appContext, { scope: "startup" });
  logBootPhase("reconcile", {
    cancelledPromoted: report.cancelledPromoted,
    askCreated: report.askCreated,
    messageResent: report.messageResent,
    staleClaimReclaimed: report.staleClaimReclaimed
  });

  // source-of-truth: cron tick 取りこぼし (プロセス落ち / 再起動) を DB から回復する。
  // race: scheduler は本呼び出しの完了**後**に生成する。先に生成すると reminder tick と recovery が並行し二重送信 race → ADR-0024
  await runStartupRecovery(client, appContext);
  startupCompleted = true;
  markAppReady();

  // single-instance: scheduler は 1 プロセスで 1 回のみ生成する。
  scheduler = createAskScheduler({
    client,
    context: appContext,
    ...(env.HEALTHCHECK_PING_URL !== undefined ? { healthcheckUrl: env.HEALTHCHECK_PING_URL } : {})
  });

  // why: Fly 自動挿入の FLY_IMAGE_REF → CI inject の GIT_SHA → 'unknown' の優先順で commit を識別する。
  const commitSha = env.FLY_IMAGE_REF ?? env.GIT_SHA ?? "unknown";
  logBootPhase("ready", {
    event: "startup.ready",
    commitSha,
    discordGuildId: appConfig.discord.guildId,
    channelId: appConfig.discord.channelId,
    memberCount: appConfig.memberUserIds.length,
    nodeVersion: process.version
  });

  // why: 起動完了後に healthchecks.io へ best-effort boot ping。未設定は no-op、失敗しても起動継続 → ADR-0034
  if (env.HEALTHCHECK_PING_URL !== undefined) {
    const pingUrl = env.HEALTHCHECK_PING_URL;
    void sendHealthcheckPing(pingUrl, { timeoutMs: HEALTHCHECK_PING_TIMEOUT_MS }).then((result) => {
      if (result.ok) {
        logger.info(
          { event: "healthcheck.boot_ping", ok: true, elapsedMs: result.elapsedMs, status: result.status },
          "Healthcheck boot ping."
        );
      } else {
        const failFields =
          result.status !== undefined
            ? { event: "healthcheck.boot_ping", ok: false, elapsedMs: result.elapsedMs, status: result.status }
            : { event: "healthcheck.boot_ping", ok: false, elapsedMs: result.elapsedMs, errorKind: result.errorKind };
        logger.warn(failFields, "Healthcheck boot ping failed.");
      }
      return undefined;
    });
  }

  logger.info(
    {
      guildId: appConfig.discord.guildId,
      channelId: appConfig.discord.channelId
    },
    "Discord bot started."
  );
};

void run().catch((error: unknown) => {
  markAppNotReady("startup_failed");
  logger.error({ error, bootId }, "Failed to start Discord bot.");
  process.exit(1);
});
