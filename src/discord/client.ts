import { Client, GatewayIntentBits } from "discord.js";

// invariant: Bot は Guilds intent のみで動作する。MessageContent / GuildMembers / GuildMessages は不要で、
//   最小権限 (OAuth scope: bot + applications.commands、Permission: View Channel / Send Messages / Embed Links) を維持する。
// @see docs/adr/0005-operations-policy.md
export const createDiscordClient = (): Client =>
  new Client({
    intents: [GatewayIntentBits.Guilds]
  });
