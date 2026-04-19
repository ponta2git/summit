import { REST, Routes } from "discord.js";

import { env } from "../env.js";
import { logger } from "../logger.js";
import { slashCommands } from "./definitions.js";

const parseApplicationIdFromToken = (token: string): string => {
  const [encoded] = token.split(".");
  if (!encoded) {
    throw new Error("DISCORD_TOKEN format is invalid.");
  }

  const decoded = Buffer.from(encoded, "base64url").toString("utf8");
  if (!/^\d{17,20}$/.test(decoded)) {
    throw new Error("Failed to infer Discord application ID from DISCORD_TOKEN.");
  }

  return decoded;
};

const run = async (): Promise<void> => {
  const applicationId = parseApplicationIdFromToken(env.DISCORD_TOKEN);
  const rest = new REST({ version: "10" }).setToken(env.DISCORD_TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(applicationId, env.DISCORD_GUILD_ID),
    { body: slashCommands }
  );

  logger.info(
    {
      guildId: env.DISCORD_GUILD_ID,
      commandCount: slashCommands.length
    },
    "Slash commands synced."
  );
};

void run().catch((error: unknown) => {
  logger.error({ error }, "Slash command sync failed.");
  process.exit(1);
});
