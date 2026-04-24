import { SlashCommandBuilder } from "discord.js";

import type { FeatureModule } from "../../discord/registry/types.js";
import { handleAskButton } from "./button.js";
import { handleAskCommand } from "./command.js";

const askSlashBuilder = new SlashCommandBuilder()
  .setName("ask")
  .setDescription("Post the weekly attendance message with buttons.");

export const askSessionModule: FeatureModule = {
  id: "ask-session",
  buttons: [{ customIdPrefix: "ask:", handle: handleAskButton }],
  commands: [{ name: "ask", builder: askSlashBuilder, handle: handleAskCommand }]
};
