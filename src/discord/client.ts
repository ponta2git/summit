import { Client, GatewayIntentBits } from "discord.js";

export const createDiscordClient = (): Client =>
  new Client({
    intents: [GatewayIntentBits.Guilds]
  });
