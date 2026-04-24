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
import { buildCancelWeekCustomId } from "../../discord/shared/customId.js";
import {
  getGuardFailureReason,
  guardChannelId,
  guardGuildId,
  guardMemberUserId,
  GUARD_REASON_TO_MESSAGE
} from "../../discord/shared/guards.js";
import {
  type AppError,
  type AppResult,
  okResult
} from "../../errors/index.js";
import type { InteractionHandlerDeps } from "../../discord/shared/interactionHandlerDeps.js";

// why: /cancel_week は破壊的なので confirmation 必須。nonce を invocation ごとに発行し stale dialog 踏み直しを判別 @see ADR-0023
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

interface CancelWeekCommandStart {
  readonly interaction: ChatInputCommandInteraction;
}

const validateCancelWeekCommand = (
  context: CancelWeekCommandStart
): AppResult<CancelWeekCommandStart, AppError> =>
  okResult(context)
    .andThen((current) => guardGuildId(current.interaction.guildId).map(() => current))
    .andThen((current) => guardChannelId(current.interaction.channelId).map(() => current))
    .andThen((current) => guardMemberUserId(current.interaction.user.id).map(() => current));

const replyCancelWeekCommandValidationError = async (
  interaction: ChatInputCommandInteraction,
  error: AppError
): Promise<void> => {
  const reason = getGuardFailureReason(error);
  if (!reason) {
    throw error;
  }
  await interaction.editReply(GUARD_REASON_TO_MESSAGE[reason]);
};

export const handleCancelWeekCommand = async (
  interaction: ChatInputCommandInteraction,
  _deps: InteractionHandlerDeps
): Promise<void> => {
  // ack: 3 秒制約。確認ボタンは ephemeral で実行者のみ視認可能。
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const validation = validateCancelWeekCommand({ interaction });
  if (validation.isErr()) {
    await replyCancelWeekCommandValidationError(interaction, validation.error);
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
