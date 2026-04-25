import { randomUUID } from "node:crypto";

import type { ScheduledTask } from "node-cron";

import { createAppContext } from "./appContext.js";
import { closeDb, db } from "./db/client.js";
import { waitForInFlightSend } from "./features/ask-session/send.js";
import { createDiscordClient } from "./discord/client.js";
import { registerInteractionHandlers } from "./discord/index.js";
import { env } from "./env.js";
import { logger } from "./logger.js";
import { buildMemberReconcileInputs } from "./members/inputs.js";
import { reconcileMembers } from "./members/reconcile.js";
import { runReconciler } from "./scheduler/reconciler.js";
import { createAskScheduler, runStartupRecovery } from "./scheduler/index.js";
import { shutdownGracefully } from "./shutdown.js";
import { appConfig } from "./userConfig.js";
import { createAppReadiness, registerReconnectReplayHandlers } from "./startup/appReadiness.js";
import { createBootPhaseLogger } from "./startup/bootLogging.js";
import { attachRateLimitLogging } from "./startup/rateLimitLogging.js";
import { sendBootHealthcheckPing } from "./startup/bootHealthcheck.js";

const appContext = createAppContext();
const client = createDiscordClient();
const readiness = createAppReadiness();
let startupCompleted = false;

registerInteractionHandlers(client, appContext, {
  getReadyState: () => readiness.state
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
const logBootPhase = createBootPhaseLogger(bootId, bootStartedAt);

registerReconnectReplayHandlers({
  client,
  context: appContext,
  readiness,
  isStartupCompleted: () => startupCompleted,
  bootId
});

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

  attachRateLimitLogging(client);

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
  readiness.markReady();

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

  sendBootHealthcheckPing(env.HEALTHCHECK_PING_URL);

  logger.info(
    {
      guildId: appConfig.discord.guildId,
      channelId: appConfig.discord.channelId
    },
    "Discord bot started."
  );
};

void run().catch((error: unknown) => {
  readiness.markNotReady("startup_failed");
  logger.error({ error, bootId }, "Failed to start Discord bot.");
  process.exit(1);
});
