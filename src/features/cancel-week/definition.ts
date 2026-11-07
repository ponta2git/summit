import { SlashCommandBuilder } from "@discordjs/builders";

export const cancelWeekCommandBuilder = new SlashCommandBuilder()
  .setName("cancel_week")
  .setDescription("今週の未作成の金曜自動募集を停止します。");
