import { MessageFlags, type ButtonInteraction } from "discord.js";

import {
  getGuardFailureReason,
  GUARD_REASON_TO_MESSAGE
} from "../../discord/shared/guards.ts";
import type { AppError } from "../../errors/index.ts";
import { logger } from "../../logger.ts";

export const handleAskPipelineError = async (
  interaction: ButtonInteraction,
  error: AppError
): Promise<void> => {
  const reason = getGuardFailureReason(error);
  if (!reason) {
    throw error;
  }

  if (reason === "invalid_custom_id") {
    logger.warn(
      { interactionId: interaction.id, userId: interaction.user.id },
      "Invalid custom_id for ask button."
    );
  }
  if (reason === "member_not_registered") {
    logger.warn(
      { interactionId: interaction.id, userId: interaction.user.id },
      "User is allowed but no matching member row."
    );
  }

  await interaction.followUp({
    content: GUARD_REASON_TO_MESSAGE[reason],
    flags: MessageFlags.Ephemeral
  });
};
