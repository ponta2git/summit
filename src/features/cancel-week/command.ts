import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type ChatInputCommandInteraction
} from "discord.js";

import { logger } from "../../logger.js";
import { cancelWeekMessages } from "./messages.js";
import { rejectMessages } from "../interaction-reject/messages.js";
import { buildCancelWeekCustomId } from "../../discord/shared/customId.js";
import { assertGuildAndChannel, assertMember } from "../../discord/shared/guards.js";

const rejectMessage = rejectMessages.reject.notMember;

// why: /cancel_week は破壊的（週全体のスキップ）なので confirmation ダイアログ必須。
//   nonce は invocation ごとに発行し、stale dialog の踏み直し判別に使う。
// @see docs/adr/0023-cancel-week-command-flow.md
const buildConfirmRow = (nonce: string): ActionRowBuilder<ButtonBuilder> => {
  const confirmButton = new ButtonBuilder()
    .setCustomId(buildCancelWeekCustomId({ kind: "cancel_week", nonce, choice: "confirm" }))
    .setLabel(cancelWeekMessages.cancelWeek.confirmButtonLabel)
    .setStyle(ButtonStyle.Danger);
  const abortButton = new ButtonBuilder()
    .setCustomId(buildCancelWeekCustomId({ kind: "cancel_week", nonce, choice: "abort" }))
    .setLabel(cancelWeekMessages.cancelWeek.abortButtonLabel)
    .setStyle(ButtonStyle.Secondary);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(confirmButton, abortButton);
};

export const handleCancelWeekCommand = async (
  interaction: ChatInputCommandInteraction
): Promise<void> => {
  // ack: 3 秒制約。確認ボタンは ephemeral 返信として発行する（実行者のみが視認可能）。
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // invariant: interaction-review cheap-first 順 (guild/channel → member)
  if (!assertGuildAndChannel(interaction.guildId, interaction.channelId) || !assertMember(interaction.user.id)) {
    await interaction.editReply(rejectMessage);
    return;
  }

  const nonce = randomUUID();
  await interaction.editReply({
    content: cancelWeekMessages.cancelWeek.confirmPrompt,
    components: [buildConfirmRow(nonce)]
  });

  logger.info(
    {
      interactionId: interaction.id,
      userId: interaction.user.id,
      nonce
    },
    "cancel_week confirmation dialog sent."
  );
};
