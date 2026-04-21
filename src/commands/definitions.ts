import { SlashCommandBuilder } from "discord.js";

import { statusCommandBuilder } from "../features/status-command/index.js";

export const commandBuilders = [
  new SlashCommandBuilder()
    .setName("ask")
    .setDescription("Post the weekly attendance message with buttons."),
  new SlashCommandBuilder()
    .setName("cancel_week")
    .setDescription("Cancel the current attendance session for this ISO week."),
  statusCommandBuilder
] as const;

export const slashCommands = commandBuilders.map((command) => command.toJSON());
