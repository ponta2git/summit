import { randomUUID } from "node:crypto";

import { createAppContext } from "../appContext.ts";
import { closeDb, db } from "../db/client.ts";
import { waitForInFlightSend } from "../features/ask-session/send.ts";
import { createDiscordClient } from "../discord/client.ts";
import { registerInteractionHandlers } from "../discord/index.ts";
import { env } from "../env.ts";
import { logger } from "../logger.ts";
import { buildMemberReconcileInputs } from "../members/inputs.ts";
import { reconcileMembers } from "../members/reconcile.ts";
import { runReconciler } from "../scheduler/reconciler.ts";
import { createAskScheduler, runStartupRecovery, type AppScheduler } from "../scheduler/index.ts";
import { runPromiseBoundary } from "../runtime/effect.ts";
import { drainResources, stopResources } from "../runtime/lifecycle.ts";
import { isShuttingDown, shutdownGracefully } from "../shutdown.ts";
import { appConfig } from "../userConfig.ts";
import { createAppReadiness, registerReconnectReplayHandlers } from "./appReadiness.ts";
import { createBootPhaseLogger } from "./bootLogging.ts";
import { attachRateLimitLogging } from "./rateLimitLogging.ts";
import { createResultNotificationRuntime } from "../notifications/runtime.ts";
import { createMaintenanceDrain } from "./maintenanceDrain.ts";

const appContext = createAppContext();
const client = createDiscordClient();
const readiness = createAppReadiness();
let startupCompleted = false;
// race: node-cron starts during schedule(); create the scheduler only after startup recovery.
let scheduler: AppScheduler | undefined;
const maintenance = createMaintenanceDrain([
  { name: "startup", stage: "admission", stop: () => readiness.markNotReady("maintenance"), drain: () => startupInFlight },
  { name: "discord_interactions", stage: "admission", stop: () => interactions.stop(), drain: () => interactions.drain() },
  { name: "reconnect_recovery", stage: "admission", stop: () => reconnect.stop(), drain: () => reconnect.drain() },
  { name: "scheduler", stage: "admission", stop: () => scheduler?.stop(), drain: () => scheduler?.drain() },
  { name: "ask_sends", stage: "admission", stop: () => undefined, drain: waitForInFlightSend },
  { name: "notification_operations", stage: "admission", stop: () => undefined, drain: () => resultNotifications?.drainOperations() },
  { name: "result_notifications", stage: "all", stop: () => resultNotifications?.stopBusiness(), drain: () => resultNotifications?.drainBusiness() }
]);
const resultNotifications = env.RESULT_NOTIFICATION_TOKEN && env.RESULT_NOTIFICATION_OPERATIONS_TOKEN && env.RESULT_NOTIFICATION_WEB_ORIGIN
  ? createResultNotificationRuntime({ client, context: appContext,
    host: env.RESULT_NOTIFICATION_BIND_HOST, port: env.RESULT_NOTIFICATION_PORT,
    token: env.RESULT_NOTIFICATION_TOKEN, operationsToken: env.RESULT_NOTIFICATION_OPERATIONS_TOKEN,
    webOrigin: env.RESULT_NOTIFICATION_WEB_ORIGIN, channelId: appConfig.discord.channelId,
    canAccept: () => startupCompleted, maintenance }) : undefined;
const wakeSchedulers = (reason: string): void => {
  scheduler?.wake(reason);
  resultNotifications?.wake(reason);
};

const interactions = registerInteractionHandlers(client, appContext, {
  getReadyState: () => maintenance.admissionOpen ? readiness.state : { ready: false, reason: "maintenance" },
  wakeScheduler: wakeSchedulers
});

const handleShutdownSignal = (signal: NodeJS.Signals): void => {
  void shutdownGracefully({
    signal,
    stopScheduler: () => stopResources([
      () => readiness.markNotReady("shutting_down"),
      () => interactions.stop(),
      () => reconnect.stop(),
      () => resultNotifications?.stop(),
      () => scheduler?.stop()
    ]),
    waitForInFlightSend: () => drainResources([
      () => startupInFlight,
      () => interactions.drain(),
      () => reconnect.drain(),
      waitForInFlightSend,
      () => scheduler?.drain(),
      () => resultNotifications?.drain()
    ]),
    closeDb,
    destroyClient: () => client.destroy()
  })
    .then((result) => {
      if (result.status !== "already_in_progress") {
        process.exit(result.status === "completed" ? 0 : 1);
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
  if (isShuttingDown() || !maintenance.admissionOpen) { return; }
  logBootPhase("db_connect");
  await resultNotifications?.start();
  if (isShuttingDown()) { resultNotifications?.stop(); return; }
  if (!maintenance.admissionOpen) { return; }

  await client.login(env.DISCORD_TOKEN);
  if (isShuttingDown() || !maintenance.admissionOpen) { return; }
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
  const report = await runPromiseBoundary(runReconciler(client, appContext, { scope: "startup" }));
  if (isShuttingDown() || !maintenance.admissionOpen) { return; }
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
  await runPromiseBoundary(runStartupRecovery(client, appContext));
  if (isShuttingDown() || !maintenance.admissionOpen) { return; }
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
