import { Client, GatewayIntentBits } from "discord.js";

import { appConfig } from "../userConfig.ts";
import { memberMentions } from "./shared/mentions.ts";

// invariant: 最小権限。Guilds intent のみで運用する。
// @see docs/discord-rule.md
// why: 表示名等に埋め込まれた everyone / role / 設定外 member の mention を既定で拒否する。
export const createDiscordClient = (): Client =>
  new Client({
    intents: [GatewayIntentBits.Guilds],
    allowedMentions: memberMentions(appConfig.memberUserIds, appConfig.dev.suppressMentions)
  });
