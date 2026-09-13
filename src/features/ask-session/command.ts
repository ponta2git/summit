import { runPromiseBoundary } from "../../runtime/effect.ts";
import * as Either from "effect/Either";
import * as Effect from "effect/Effect";
import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";

import type { AppError } from "../../errors/index.ts";
import { fromDiscordCall } from "../../errors/effect.ts";
import { logger } from "../../logger.ts";
import { askMessages } from "./messages.ts";
import { assertNever } from "../../util/assertNever.ts";
import {
  getGuardFailureReason,
  guardChannelId,
  guardGuildId,
  guardMemberUserId,
  GUARD_REASON_TO_MESSAGE
} from "../../discord/shared/guards.ts";
import type { InteractionHandlerDeps } from "../../discord/shared/dispatcher.ts";

interface AskCommandPipelineStart {
  readonly interaction: ChatInputCommandInteraction;
  readonly deps: InteractionHandlerDeps;
}

const validateAskCommand = (
  context: AskCommandPipelineStart
): Either.Either<AskCommandPipelineStart, AppError> =>
  Either.gen(function* () {
    yield* guardGuildId(context.interaction.guildId);
    yield* guardChannelId(context.interaction.channelId);
    yield* guardMemberUserId(context.interaction.user.id);
    return context;
  });

const sendAskStep = (
  context: AskCommandPipelineStart
): Effect.Effect<Awaited<ReturnType<InteractionHandlerDeps["sendAsk"]>>, AppError> =>
  fromDiscordCall(
    () => context.deps.sendAsk({
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
  const result = await runPromiseBoundary(Effect.either(Effect.gen(function* () {
    const validated = yield* validateAskCommand(pipelineStart);
    return yield* sendAskStep(validated);
  })));

  await Either.match(result, {
    onRight: async (sendResult) => {
      if (sendResult.status === "queued") {
        deps.wakeScheduler?.("ask_command_queued");
        await interaction.editReply(askMessages.interaction.ask.queued);
        return;
      }

      if (sendResult.status === "skipped") {
        await interaction.editReply(askMessages.interaction.ask.skippedAlreadySent);
        return;
      }

      // invariant: SendAskMessageResult.status 追加時に型エラーで気付くため assertNever を残す。
      return assertNever(sendResult.status, "handleAskCommand: sendAsk result.status");
    },
    onLeft: (error) => replyAskCommandError(interaction, error)
  });
};
