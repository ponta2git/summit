import { Client, GatewayIntentBits } from "discord.js";

import { appConfig } from "../userConfig.ts";

// invariant: 最小権限。Guilds intent のみで運用する。
// @see docs/discord-rule.md
// why: dev.suppressMentions 有効時のみ client-level で mentions を全抑止し、
//   本文からの mention 除去と二段構えにする。本番 (false) は Discord 既定挙動に委ねる。
export const createDiscordClient = (): Client =>
  new Client({
    intents: [GatewayIntentBits.Guilds],
    ...(appConfig.dev.suppressMentions ? { allowedMentions: { parse: [] } } : {})
  });
