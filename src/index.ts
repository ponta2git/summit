import { randomUUID } from "node:crypto";

import { createAppContext } from "./appContext.ts";
import { closeDb, db } from "./db/client.ts";
import { waitForInFlightSend } from "./features/ask-session/send.ts";
import { createDiscordClient } from "./discord/client.ts";
import { registerInteractionHandlers } from "./discord/index.ts";
import { env } from "./env.ts";
import { logger } from "./logger.ts";
import { buildMemberReconcileInputs } from "./members/inputs.ts";
import { reconcileMembers } from "./members/reconcile.ts";
import { runReconciler } from "./scheduler/reconciler.ts";
import { createAskScheduler, runStartupRecovery, type AppScheduler } from "./scheduler/index.ts";
import { unwrapResultAsync } from "./errors/result.ts";
import { isShuttingDown, shutdownGracefully } from "./shutdown.ts";
import { appConfig } from "./userConfig.ts";
import { createAppReadiness, registerReconnectReplayHandlers } from "./startup/appReadiness.ts";
import { createBootPhaseLogger } from "./startup/bootLogging.ts";
import { attachRateLimitLogging } from "./startup/rateLimitLogging.ts";
import { createResultNotificationRuntime } from "./notifications/runtime.ts";

const appContext = createAppContext();
const client = createDiscordClient();
const readiness = createAppReadiness();
let startupCompleted = false;
const resultNotifications = env.RESULT_NOTIFICATION_TOKEN && env.RESULT_NOTIFICATION_OPERATIONS_TOKEN && env.RESULT_NOTIFICATION_WEB_ORIGIN
  ? createResultNotificationRuntime({ client, context: appContext,
    host: env.RESULT_NOTIFICATION_BIND_HOST, port: env.RESULT_NOTIFICATION_PORT,
    token: env.RESULT_NOTIFICATION_TOKEN, operationsToken: env.RESULT_NOTIFICATION_OPERATIONS_TOKEN,
    webOrigin: env.RESULT_NOTIFICATION_WEB_ORIGIN, channelId: appConfig.discord.channelId,
    canAccept: () => startupCompleted }) : undefined;
const wakeSchedulers = (reason: string): void => {
  scheduler?.wake(reason);
  resultNotifications?.wake(reason);
};

const interactions = registerInteractionHandlers(client, appContext, {
  getReadyState: () => readiness.state,
  wakeScheduler: wakeSchedulers
});

// race: scheduler は runStartupRecovery 完了後に生成する。node-cron は schedule() 時点で
//   auto-start するため、top-level 生成すると startup recovery と reminder tick が並行し
//   recovery と scheduler の重複 enqueue を増やす。
let scheduler: AppScheduler | undefined;

const handleShutdownSignal = (signal: NodeJS.Signals): void => {
  void shutdownGracefully({
    signal,
    stopScheduler: () => {
      interactions.stop();
      readiness.markNotReady("shutting_down");
      reconnect.stop();
      resultNotifications?.stop();
      scheduler?.stop();
    },
    waitForInFlightSend: async () => {
      const results = await Promise.allSettled([startupInFlight, interactions.drain(), reconnect.drain(),
        waitForInFlightSend(), scheduler?.drain(), resultNotifications?.drain()]);
      const failed = results.find(result => result.status === "rejected");
      if (failed) { throw failed.reason; }
    },
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
const bootId = randomUUID();
const bootStartedAt = Date.now();
const logBootPhase = createBootPhaseLogger(bootId, bootStartedAt);

const reconnect = registerReconnectReplayHandlers({
  client,
  context: appContext,
  readiness,
  isStartupCompleted: () => startupCompleted,
  bootId,
  wakeScheduler: wakeSchedulers
});

const run = async (): Promise<void> => {
  logBootPhase("boot_start");

  // why: user config の member SSoT を起動時に DB へ反映。cron 登録・login より前に完了させる。
  await reconcileMembers(
    buildMemberReconcileInputs(appConfig.memberUserIds, appConfig.memberDisplayNames),
    db
  );
  if (isShuttingDown()) { return; }
  logBootPhase("db_connect");
  await resultNotifications?.start();
  if (isShuttingDown()) { resultNotifications?.stop(); return; }

  await client.login(env.DISCORD_TOKEN);
  if (isShuttingDown()) { return; }
  logBootPhase("login");

  attachRateLimitLogging(client);

  // why: 本番 invariant (OFF) を覆している状態を起動時 1 回だけ warn で明示する。
  if (appConfig.dev.suppressMentions) {
    logger.warn(
      { devMentionSuppression: true, mentionSuppression: "client-default" },
      "Dev mention suppression is ON. Push mentions are suppressed and `<@id>` lines are omitted from message bodies."
    );
  }

  // source-of-truth: DB と Discord の invariant を収束させる。CAS 冪等のため scheduler との競合は race lost として扱う。
  const report = await unwrapResultAsync(runReconciler(client, appContext, { scope: "startup" }));
  if (isShuttingDown()) { return; }
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
  await unwrapResultAsync(runStartupRecovery(client, appContext));
  if (isShuttingDown()) { return; }
  startupCompleted = true;
  reconnect.completeStartup();

  // single-instance: scheduler は 1 プロセスで 1 回のみ生成する。
  scheduler = createAskScheduler({
    client,
    context: appContext,
    wakeResultNotifications: reason => resultNotifications?.wake(reason)
  });
  resultNotifications?.wake("startup");

  // why: Fly 自動挿入の FLY_IMAGE_REF → CI inject の GIT_SHA → 'unknown' の優先順で commit を識別する。
  const commitSha = env.FLY_IMAGE_REF ?? env.GIT_SHA ?? "unknown";
  logBootPhase("ready", {
    event: "startup.ready",
    applicationReady: readiness.state.ready,
    readinessReason: readiness.state.reason,
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

const startupInFlight = run().catch((error: unknown) => {
  if (isShuttingDown()) { return; }
  readiness.markNotReady("startup_failed");
  logger.error({ error, bootId }, "Failed to start Discord bot.");
  process.exit(1);
});
