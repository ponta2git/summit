import { SlashCommandBuilder } from "discord.js";

export const statusCommandBuilder = new SlashCommandBuilder()
  .setName("status")
  .setDescription("現在の週次セッション状態をエフェメラル表示する（メンバー限定）。");
