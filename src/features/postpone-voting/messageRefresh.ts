import type { ButtonInteraction, Client } from "discord.js";
import * as Effect from "effect/Effect";
import type { AppContext } from "../../appContext.ts";
import type { AppError } from "../../errors/index.ts";
import { logger } from "../../logger.ts";
import { updatePostponeMessage } from "./messageEditor.ts";

export const refreshPostponeMessage = (
  client: Client,
  context: AppContext,
  interaction: ButtonInteraction,
  sessionId: string
): Effect.Effect<void, AppError> =>
  updatePostponeMessage(client, context, { id: sessionId }, interaction.message).pipe(Effect.catchAll(error => {
    if (error.code !== "DISCORD_API") { return Effect.fail(error); }
    logger.warn({ error, sessionId, interactionId: interaction.id }, "Failed to edit postpone message after response.");
    return Effect.void;
  }));
