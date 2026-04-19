import { closeDb, db } from "./db/client.js";
import { waitForInFlightSend } from "./discord/askMessage.js";
import { createDiscordClient } from "./discord/client.js";
import { registerInteractionHandlers } from "./discord/interactions.js";
import { env } from "./env.js";
import { logger } from "./logger.js";
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
  process.once(signal, () => {
    handleShutdownSignal(signal);
  });
}

const run = async (): Promise<void> => {
  await client.login(env.DISCORD_TOKEN);

  logger.info(
    {
      guildId: env.DISCORD_GUILD_ID,
      channelId: env.DISCORD_CHANNEL_ID
    },
    "Discord bot started."
  );

  await runStartupRecovery(client, db, systemClock);
};

void run().catch((error: unknown) => {
  logger.error({ error }, "Failed to start Discord bot.");
  process.exit(1);
});
