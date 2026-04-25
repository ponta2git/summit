import { SlashCommandBuilder } from "discord.js";

import type { FeatureModule } from "../../discord/registry/types.js";
import { ASK_ABSENT_CUSTOM_ID_PREFIX } from "../../discord/shared/customId.js";
import { handleAskButton } from "./button.js";
import { handleAbsentConfirmButton } from "./absentConfirm.js";
import { handleAskCommand } from "./command.js";

const askSlashBuilder = new SlashCommandBuilder()
  .setName("ask")
  .setDescription("今週の出欠確認を投稿します。");

export const askSessionModule: FeatureModule = {
  id: "ask-session",
  buttons: [
    { customIdPrefix: "ask:", handle: handleAskButton },
    { customIdPrefix: ASK_ABSENT_CUSTOM_ID_PREFIX, handle: handleAbsentConfirmButton }
  ],
  commands: [{ name: "ask", builder: askSlashBuilder, handle: handleAskCommand }]
};
