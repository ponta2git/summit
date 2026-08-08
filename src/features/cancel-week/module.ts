import { SlashCommandBuilder } from "discord.js";

import type { FeatureModule } from "../../discord/registry/types.ts";
import { CANCEL_WEEK_CUSTOM_ID_PREFIX } from "../../discord/shared/customId.ts";
import { handleCancelWeekButton } from "./button.ts";
import { handleCancelWeekCommand } from "./command.ts";

const cancelWeekSlashBuilder = new SlashCommandBuilder()
  .setName("cancel_week")
  .setDescription("今週の出欠確認をお休みにします。");

export const cancelWeekModule: FeatureModule = {
  id: "cancel-week",
  buttons: [{ customIdPrefix: CANCEL_WEEK_CUSTOM_ID_PREFIX, handle: handleCancelWeekButton }],
  commands: [
    { name: "cancel_week", builder: cancelWeekSlashBuilder, handle: handleCancelWeekCommand }
  ]
};
