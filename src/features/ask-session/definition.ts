import { SlashCommandBuilder } from "@discordjs/builders";

export const askCommandBuilder = new SlashCommandBuilder()
  .setName("ask")
  .setDescription("当日の出欠確認を投稿します（21:30より前）。");
