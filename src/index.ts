import { closeDb, db } from "./db/client.js";
import { waitForInFlightSend } from "./discord/ask/send.js";
import { createDiscordClient } from "./discord/client.js";
import { registerInteractionHandlers } from "./discord/index.js";
import { env } from "./env.js";
import { logger } from "./logger.js";
import { buildMemberReconcileInputs } from "./members.js";
import { reconcileMembers } from "./members/reconcile.js";
import { createAskScheduler, runStartupRecovery } from "./scheduler/index.js";
import { shutdownGracefully } from "./shutdown.js";
import { systemClock } from "./time/index.js";

const client = createDiscordClient();
registerInteractionHandlers(client);

const scheduler = createAskScheduler({ client });

const handleShutdownSignal = (signal: NodeJS.Signals): void => {
  void shutdownGracefully({
    signal,
    stopScheduler: () => {
      scheduler.askTask.stop();
      scheduler.deadlineTask.stop();
    },
    waitForInFlightSend,
    closeDb,
    destroyClient: () => client.destroy()
  })
    .then((didStart) => {
      if (didStart) {
        process.exit(0);
      }
    })
    .catch((error: unknown) => {
      logger.error({ error, signal }, "Fatal shutdown error.");
      process.exit(1);
    });
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  // idempotent: once で同一シグナル多重発火を防ぐ。二重 shutdown は shutdownGracefully 側でもガード。
  process.once(signal, () => {
    handleShutdownSignal(signal);
  });
}

const run = async (): Promise<void> => {
  // why: env を SSoT とし起動時に DB へ反映 (ADR-0012)
  //   cron 登録・bot login より前に完了させ、失敗時は起動を中止する。
  await reconcileMembers(
    buildMemberReconcileInputs(env.MEMBER_USER_IDS, env.MEMBER_DISPLAY_NAMES),
    db
  );

  await client.login(env.DISCORD_TOKEN);

  // why: 本番 invariant (DEV_SUPPRESS_MENTIONS 未設定=false) を覆して通知挙動を変えている状態を
  //   見逃さないよう起動時に 1 回だけ warn で明示する。毎送信ログに混ぜるとノイズになるため起動時限定。
  // @see docs/adr/0011-dev-mention-suppression.md
  if (env.DEV_SUPPRESS_MENTIONS) {
    logger.warn(
      { devMentionSuppression: true, mentionSuppression: "client-default" },
      "Dev mention suppression is ON. Push mentions are suppressed and `<@id>` lines are omitted from message bodies."
    );
  }

  logger.info(
    {
      guildId: env.DISCORD_GUILD_ID,
      channelId: env.DISCORD_CHANNEL_ID
    },
    "Discord bot started."
  );

  // source-of-truth: cron tick 取りこぼし (プロセス落ち / 再起動) を DB から回復する。
  //   login 後に実行することで Discord message の edit もできる状態で呼び出す。
  await runStartupRecovery(client, db, systemClock);
};

void run().catch((error: unknown) => {
  logger.error({ error }, "Failed to start Discord bot.");
  process.exit(1);
});
