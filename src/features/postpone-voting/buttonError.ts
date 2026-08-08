import { MessageFlags, type ButtonInteraction } from "discord.js";

import {
  getGuardFailureReason,
  GUARD_REASON_TO_MESSAGE
} from "../../discord/shared/guards.ts";
import type { AppError } from "../../errors/index.ts";
import { logger } from "../../logger.ts";

export const handlePostponePipelineError = async (
  interaction: ButtonInteraction,
  error: AppError
): Promise<void> => {
  const reason = getGuardFailureReason(error);
  if (!reason) {
    throw error;
  }

  logger.info(
    {
      interactionId: interaction.id,
      customId: interaction.customId,
      userId: interaction.user.id,
      reason
    },
    "Rejected postpone button interaction by guard."
  );

  await interaction.followUp({
    content: GUARD_REASON_TO_MESSAGE[reason],
    flags: MessageFlags.Ephemeral
  });
};
