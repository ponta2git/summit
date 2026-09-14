import { SlashCommandBuilder } from "@discordjs/builders";

export const statusCommandBuilder = new SlashCommandBuilder()
  .setName("status")
  .setDescription("今週の状況を自分だけに表示します。");
