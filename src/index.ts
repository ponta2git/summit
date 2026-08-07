import { randomUUID } from "node:crypto";

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
import { createAskScheduler, runStartupRecovery, type AppScheduler } from "./scheduler/index.js";
import { shutdownGracefully } from "./shutdown.js";
import { appConfig } from "./userConfig.js";
import { createAppReadiness, registerReconnectReplayHandlers } from "./startup/appReadiness.js";
import { createBootPhaseLogger } from "./startup/bootLogging.js";
import { attachRateLimitLogging } from "./startup/rateLimitLogging.js";

const appContext = createAppContext();
const client = createDiscordClient();
const readiness = createAppReadiness();
let startupCompleted = false;

registerInteractionHandlers(client, appContext, {
  getReadyState: () => readiness.state,
  wakeScheduler: (reason) => scheduler?.wake(reason)
});

// race: scheduler は runStartupRecovery 完了後に生成する。node-cron は schedule() 時点で
//   auto-start するため、top-level 生成すると startup recovery と reminder tick が並行し
//   recovery と scheduler の重複 enqueue を増やす → ADR-0051
let scheduler: AppScheduler | undefined;

const handleShutdownSignal = (signal: NodeJS.Signals): void => {
  void shutdownGracefully({
    signal,
    stopScheduler: () => {
      if (!scheduler) {
        return;
      }
      scheduler.stop();
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
// @see ADR-0051
const bootId = randomUUID();
const bootStartedAt = Date.now();
const logBootPhase = createBootPhaseLogger(bootId, bootStartedAt);

registerReconnectReplayHandlers({
  client,
  context: appContext,
  readiness,
  isStartupCompleted: () => startupCompleted,
  bootId,
  wakeScheduler: (reason) => scheduler?.wake(reason)
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

  // source-of-truth: DB と Discord の invariant を収束させる。CAS 冪等のため scheduler との競合は race lost として扱う。
  // @see ADR-0051
  const reportResult = await runReconciler(client, appContext, { scope: "startup" });
  const report = reportResult.match(
    (value) => value,
    (error) => { throw error; }
  );
  logBootPhase("reconcile", {
    cancelledPromoted: report.cancelledPromoted,
    askCreated: report.askCreated,
    messageIntentsQueued: report.messageIntentsQueued,
    outboxClaimReleased: report.outboxClaimReleased,
    outboxDeadLettersRequeued: report.outboxDeadLettersRequeued,
    outboxSuccessorsRequeued: report.outboxSuccessorsRequeued
  });

  // source-of-truth: cron tick 取りこぼし (プロセス落ち / 再起動) を DB から回復する。
  // race: scheduler は本呼び出しの完了**後**に生成し、startup recovery との重複処理を避ける。
  const startupRecoveryResult = await runStartupRecovery(client, appContext);
  startupRecoveryResult.match(
    () => undefined,
    (error) => { throw error; }
  );
  startupCompleted = true;
  readiness.markReady();

  // single-instance: scheduler は 1 プロセスで 1 回のみ生成する。
  scheduler = createAskScheduler({
    client,
    context: appContext
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
