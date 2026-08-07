import type { ButtonInteraction } from "discord.js";
import { type ResultAsync, okAsync } from "neverthrow";

import type { AppContext } from "../../appContext.js";
import type { AppError } from "../../errors/index.js";
import { fromDatabasePromise, fromDiscordPromise } from "../../errors/result.js";
import { logger } from "../../logger.js";
import { renderPostponeBody } from "./render.js";
import { buildPostponeMessageViewModel } from "./viewModel.js";

export const refreshPostponeMessage = (
  context: AppContext,
  interaction: ButtonInteraction,
  sessionId: string
): ResultAsync<void, AppError> =>
  fromDatabasePromise(
    Promise.all([
      context.ports.responses.listResponses(sessionId),
      context.ports.members.listMembers()
    ]),
    "Failed to load postpone message snapshot."
  )
    .andThen(([responses, memberRows]) =>
      fromDatabasePromise(
        context.ports.sessions.findSessionById(sessionId),
        "Failed to reload session after postpone response."
      ).map((freshSession) => ({ freshSession, responses, memberRows }))
    )
    .andThen(({ freshSession, responses, memberRows }) => {
      if (!freshSession?.postponeMessageId) {
        return okAsync(undefined);
      }

      const rendered = renderPostponeBody(
        buildPostponeMessageViewModel(freshSession, responses, memberRows, {
          disabled: false
        })
      );
      const editPayload = {
        content: rendered.content ?? "",
        ...(rendered.components ? { components: rendered.components } : {})
      };

      return fromDiscordPromise(
        interaction.message.edit(editPayload),
        "Failed to edit postpone message after response."
      )
        .map(() => undefined)
        .orElse((error) => {
          logger.warn(
            {
              error,
              interactionId: interaction.id,
              customId: interaction.customId,
              sessionId,
              weekKey: freshSession.weekKey,
              userId: interaction.user.id,
              messageId: freshSession.postponeMessageId
            },
            "Failed to edit postpone message after response."
          );
          return okAsync(undefined);
        });
    });
