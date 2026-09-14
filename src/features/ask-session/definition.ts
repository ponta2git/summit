import { SlashCommandBuilder } from "@discordjs/builders";

export const askCommandBuilder = new SlashCommandBuilder()
  .setName("ask")
  .setDescription("今週の出欠確認を投稿します。");
