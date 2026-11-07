import { SlashCommandBuilder } from "@discordjs/builders";

export const statusCommandBuilder = new SlashCommandBuilder()
  .setName("status")
  .setDescription("進行中の募集と今週の自動募集状況を自分だけに表示します。");
