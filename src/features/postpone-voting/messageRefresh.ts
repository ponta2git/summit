import type { ButtonInteraction, Client } from "discord.js";
import { type ResultAsync, errAsync, okAsync } from "neverthrow";
import type { AppContext } from "../../appContext.ts";
import type { AppError } from "../../errors/index.ts";
import { logger } from "../../logger.ts";
import { updatePostponeMessage } from "./messageEditor.ts";

export const refreshPostponeMessage = (
  client: Client,
  context: AppContext,
  interaction: ButtonInteraction,
  sessionId: string
): ResultAsync<void, AppError> =>
  updatePostponeMessage(client, context, { id: sessionId }, interaction.message).orElse(error => {
    if (error.code !== "DISCORD_API") { return errAsync(error); }
    logger.warn({ error, sessionId, interactionId: interaction.id }, "Failed to edit postpone message after response.");
    return okAsync(undefined);
  });
