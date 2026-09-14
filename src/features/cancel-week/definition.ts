import { SlashCommandBuilder } from "@discordjs/builders";

export const cancelWeekCommandBuilder = new SlashCommandBuilder()
  .setName("cancel_week")
  .setDescription("今週の出欠確認をお休みにします。");
