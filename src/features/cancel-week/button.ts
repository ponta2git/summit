import { MessageFlags, type ButtonInteraction } from "discord.js";

import { logger } from "../../logger.js";
import { cancelWeekMessages } from "./messages.js";
import { applyManualSkip } from "../../orchestration/index.js";
import {
  getGuardFailureReason,
  guardCancelWeekCustomId,
  guardChannelId,
  guardGuildId,
  guardMemberUserId,
  GUARD_REASON_TO_MESSAGE
} from "../../discord/shared/guards.js";
import type { InteractionHandlerDeps } from "../../discord/shared/dispatcher.js";
import {
  type AppError,
  type AppResult,
  okResult
} from "../../errors/index.js";

interface CancelWeekButtonStart {
  readonly interaction: ButtonInteraction;
  readonly deps: InteractionHandlerDeps;
}

interface CancelWeekButtonParsed extends CancelWeekButtonStart {
  readonly choice: "confirm" | "abort";
}

const validateCancelWeekButton = (
  context: CancelWeekButtonStart
): AppResult<CancelWeekButtonParsed, AppError> =>
  okResult(context)
    .andThen((current) => guardGuildId(current.interaction.guildId).map(() => current))
    .andThen((current) => guardChannelId(current.interaction.channelId).map(() => current))
    .andThen((current) => guardMemberUserId(current.interaction.user.id).map(() => current))
    .andThen((current) =>
      guardCancelWeekCustomId(current.interaction.customId).map((parsed) => ({
        ...current,
        choice: parsed.choice
      }))
    );

const replyCancelWeekButtonError = async (
  interaction: ButtonInteraction,
  error: AppError
): Promise<void> => {
  const reason = getGuardFailureReason(error);
  if (reason) {
    if (reason === "invalid_custom_id") {
      logger.warn(
        { interactionId: interaction.id, customId: interaction.customId },
        "Invalid cancel_week custom_id."
      );
      await interaction.editReply({
        content: GUARD_REASON_TO_MESSAGE[reason],
        components: []
      });
      return;
    }

    await interaction.followUp({
      content: GUARD_REASON_TO_MESSAGE[reason],
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  logger.error(
    {
      error,
      errorCode: error.code,
      interactionId: interaction.id,
      userId: interaction.user.id
    },
    "Failed to apply cancel_week confirmation."
  );
  await interaction.editReply({
    content: cancelWeekMessages.cancelWeek.failed,
    components: []
  });
};

/**
 * Handle cancel_week confirm/abort button from the ephemeral confirmation dialog.
 *
 * @remarks
 * 確認ダイアログは ephemeral で実行者のみ押下可。confirm で週全体を SKIPPED に遷移、abort は dialog 更新のみ。
 * cheap-first guard は dispatcher 側でも実施済みだが防御的に再評価する。
 * @see ADR-0023
 */
export const handleCancelWeekButton = async (
  interaction: ButtonInteraction,
  deps: InteractionHandlerDeps,
  options: {
    readonly acknowledged?: boolean;
  } = {}
): Promise<void> => {
  if (!options.acknowledged) {
    // ack: ephemeral confirmation の更新のため入口で deferUpdate する。
    await interaction.deferUpdate();
  }

  const validation = validateCancelWeekButton({ interaction, deps });
  if (validation.isErr()) {
    await replyCancelWeekButtonError(interaction, validation.error);
    return;
  }

  const { choice } = validation.value;

  if (choice === "abort") {
    await interaction.editReply({
      content: cancelWeekMessages.cancelWeek.aborted,
      components: []
    });
    logger.info(
      { interactionId: interaction.id, userId: interaction.user.id },
      "cancel_week aborted by invoker."
    );
    return;
  }

  const result = await applyManualSkip(deps.client, deps.context, {
    invokerUserId: interaction.user.id
  });

  await result.match(
    async (outcome) => {
      deps.wakeScheduler?.("cancel_week_confirmed");
      await interaction.editReply({
        content: cancelWeekMessages.cancelWeek.done({ count: outcome.skippedCount }),
        components: []
      });
    },
    async (error) => replyCancelWeekButtonError(interaction, error)
  );
};
