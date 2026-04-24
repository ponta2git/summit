import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";

import { DiscordApiError, toAppError } from "../../errors/index.js";
import { logger } from "../../logger.js";
import { askMessages } from "./messages.js";
import { assertNever } from "../../util/assertNever.js";
import { assertGuildAndChannel, assertMember } from "../../discord/shared/guards.js";
import type { InteractionHandlerDeps } from "../../discord/shared/dispatcher.js";
import { rejectMessages } from "../interaction-reject/messages.js";

const rejectMessage = rejectMessages.reject.notMember;

const sendAskOrThrow = async (
  deps: InteractionHandlerDeps,
  invokerId: string
): ReturnType<InteractionHandlerDeps["sendAsk"]> => {
  try {
    return await deps.sendAsk({
      trigger: "command",
      invokerId
    });
  } catch (error: unknown) {
    throw new DiscordApiError("Failed to execute /ask.", { cause: error });
  }
};

export const handleAskCommand = async (
  interaction: ChatInputCommandInteraction,
  deps: InteractionHandlerDeps
): Promise<void> => {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!assertGuildAndChannel(interaction.guildId, interaction.channelId) || !assertMember(interaction.user.id)) {
    await interaction.editReply(rejectMessage);
    return;
  }

  try {
    const result = await sendAskOrThrow(deps, interaction.user.id);

    if (result.status === "sent") {
      await interaction.editReply(askMessages.interaction.ask.sent);
      return;
    }

    if (result.status === "skipped") {
      await interaction.editReply(askMessages.interaction.ask.skippedAlreadySent);
      return;
    }

    // invariant: SendAskMessageResult.status 追加時に型エラーで気付くため assertNever を残す。
    return assertNever(result.status, "handleAskCommand: sendAsk result.status");
  } catch (error: unknown) {
    const appError = toAppError(error, "Failed to execute /ask.");

    logger.error(
      {
        error: appError,
        errorCode: appError.code,
        interactionId: interaction.id,
        userId: interaction.user.id
      },
      "Failed to execute /ask."
    );
    await interaction.editReply(askMessages.interaction.ask.failed);
  }
};
