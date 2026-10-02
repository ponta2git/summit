import type { ButtonInteraction, Client } from "discord.js";
import type * as Effect from "effect/Effect";
import type { AppContext } from "../../appContext.ts";
import type { AppError } from "../../errors/index.ts";
import { updatePostponeMessage } from "./messageEditor.ts";
import { bestEffortMessageUpdate } from "../../discord/shared/messageUpdates.ts";

export const refreshPostponeMessage = (
  client: Client,
  context: AppContext,
  interaction: ButtonInteraction,
  sessionId: string
): Effect.Effect<void, AppError> =>
  bestEffortMessageUpdate(updatePostponeMessage(client, context, { id: sessionId }, interaction.message), sessionId, "postpone");
