import { REST, Routes } from "discord.js";

import { env } from "../env.js";
import { logger } from "../logger.js";
import { appConfig } from "../userConfig.js";
import { slashCommands } from "./definitions.js";

// why: Discord token の第一セグメント (base64url) がそのまま application ID を表す仕様。
//   追加の HTTP 呼び出しをせずに sync 実行できるため CI / pnpm commands:sync で使える。
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

  // why: guild-scoped bulk overwrite で冪等に同期する。global 登録は伝播に最大 1 時間かかるため使わない。
  // @see docs/adr/0004-discord-interaction-architecture.md
  await rest.put(
    Routes.applicationGuildCommands(applicationId, appConfig.discord.guildId),
    { body: slashCommands }
  );

  logger.info(
    {
      guildId: appConfig.discord.guildId,
      commandCount: slashCommands.length
    },
    "Slash commands synced."
  );
};

void run().catch((error: unknown) => {
  logger.error({ error }, "Slash command sync failed.");
  process.exit(1);
});
