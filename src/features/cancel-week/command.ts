import * as Either from "effect/Either";
import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type ChatInputCommandInteraction
} from "discord.js";

import { logger } from "../../logger.ts";
import { cancelWeekMessages } from "./messages.ts";
import { buildCancelWeekCustomId } from "../../discord/shared/customId.ts";
import {
  getGuardFailureReason,
  guardChannelId,
  guardGuildId,
  guardMemberUserId,
  GUARD_REASON_TO_MESSAGE
} from "../../discord/shared/guards.ts";
import type { AppError } from "../../errors/index.ts";
import type { InteractionHandlerDeps } from "../../discord/shared/interactionHandlerDeps.ts";
import { isoWeekKey } from "../../time/index.ts";

// why: 週を跨いだdialogで別週を取り消さないよう、確認対象週をIDへ固定する。
const buildConfirmRow = (weekKey: string, nonce: string): ActionRowBuilder<ButtonBuilder> => {
  const confirmButton = new ButtonBuilder()
    .setCustomId(buildCancelWeekCustomId({ kind: "cancel_week", weekKey, nonce, choice: "confirm" }))
    .setLabel(cancelWeekMessages.cancelWeek.confirmButtonLabel)
    .setStyle(ButtonStyle.Danger);
  const abortButton = new ButtonBuilder()
    .setCustomId(buildCancelWeekCustomId({ kind: "cancel_week", weekKey, nonce, choice: "abort" }))
    .setLabel(cancelWeekMessages.cancelWeek.abortButtonLabel)
    .setStyle(ButtonStyle.Secondary);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(confirmButton, abortButton);
};

interface CancelWeekCommandStart {
  readonly interaction: ChatInputCommandInteraction;
}

const validateCancelWeekCommand = (
  context: CancelWeekCommandStart
): Either.Either<CancelWeekCommandStart, AppError> =>
  Either.gen(function* () {
    yield* guardGuildId(context.interaction.guildId);
    yield* guardChannelId(context.interaction.channelId);
    yield* guardMemberUserId(context.interaction.user.id);
    return context;
  });

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
  deps: InteractionHandlerDeps
): Promise<void> => {
  // ack: 3 秒制約。確認ボタンは ephemeral で実行者のみ視認可能。
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const validation = validateCancelWeekCommand({ interaction });
  if (Either.isLeft(validation)) {
    await replyCancelWeekCommandValidationError(interaction, validation.left);
    return;
  }

  const nonce = randomUUID();
  await interaction.editReply({
    content: cancelWeekMessages.cancelWeek.confirmPrompt,
    components: [buildConfirmRow(isoWeekKey(deps.context.clock.now()), nonce)]
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
