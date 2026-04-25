import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { type ResultAsync } from "neverthrow";

import {
  type AppError,
  type AppResult,
  okResult
} from "../../errors/index.js";
import { fromDiscordPromise, toResultAsync } from "../../errors/result.js";
import { logger } from "../../logger.js";
import { askMessages } from "./messages.js";
import { assertNever } from "../../util/assertNever.js";
import {
  getGuardFailureReason,
  guardChannelId,
  guardGuildId,
  guardMemberUserId,
  GUARD_REASON_TO_MESSAGE
} from "../../discord/shared/guards.js";
import type { InteractionHandlerDeps } from "../../discord/shared/dispatcher.js";

interface AskCommandPipelineStart {
  readonly interaction: ChatInputCommandInteraction;
  readonly deps: InteractionHandlerDeps;
}

const validateAskCommand = (
  context: AskCommandPipelineStart
): AppResult<AskCommandPipelineStart, AppError> =>
  okResult(context)
    .andThen((current) => guardGuildId(current.interaction.guildId).map(() => current))
    .andThen((current) => guardChannelId(current.interaction.channelId).map(() => current))
    .andThen((current) => guardMemberUserId(current.interaction.user.id).map(() => current));

const sendAskStep = (
  context: AskCommandPipelineStart
): ResultAsync<Awaited<ReturnType<InteractionHandlerDeps["sendAsk"]>>, AppError> =>
  fromDiscordPromise(
    context.deps.sendAsk({
      trigger: "command",
      invokerId: context.interaction.user.id
    }),
    "Failed to execute /ask."
  );

const replyAskCommandError = async (
  interaction: ChatInputCommandInteraction,
  error: AppError
): Promise<void> => {
  const reason = getGuardFailureReason(error);
  if (reason) {
    await interaction.editReply(GUARD_REASON_TO_MESSAGE[reason]);
    return;
  }

  logger.error(
    {
      error,
      errorCode: error.code,
      interactionId: interaction.id,
      userId: interaction.user.id
    },
    "Failed to execute /ask."
  );
  await interaction.editReply(askMessages.interaction.ask.failed);
};

export const handleAskCommand = async (
  interaction: ChatInputCommandInteraction,
  deps: InteractionHandlerDeps
): Promise<void> => {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const pipelineStart: AskCommandPipelineStart = { interaction, deps };
  const result = await toResultAsync(validateAskCommand(pipelineStart))
    .andThen(sendAskStep);

  await result.match(
    async (sendResult) => {
      if (sendResult.status === "sent") {
        deps.wakeScheduler?.("ask_command_sent");
        await interaction.editReply(askMessages.interaction.ask.sent);
        return;
      }

      if (sendResult.status === "skipped") {
        await interaction.editReply(askMessages.interaction.ask.skippedAlreadySent);
        return;
      }

      // invariant: SendAskMessageResult.status 追加時に型エラーで気付くため assertNever を残す。
      return assertNever(sendResult.status, "handleAskCommand: sendAsk result.status");
    },
    async (error) => replyAskCommandError(interaction, error)
  );
};
