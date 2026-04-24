import {
  type ButtonInteraction,
  type Client,
  type Interaction,
  type InteractionReplyOptions,
  MessageFlags
} from "discord.js";

import type { AppContext } from "../../appContext.js";
import { logger } from "../../logger.js";
import { rejectMessages } from "../../features/interaction-reject/messages.js";
import { sendAskMessage } from "../../features/ask-session/send.js";
import { handlePostponeButton } from "../../features/postpone-voting/button.js";
import { handleAskButton } from "../../features/ask-session/button.js";
import { handleCancelWeekButton } from "../../features/cancel-week/button.js";
import { handleAskCommand } from "../../features/ask-session/command.js";
import { handleCancelWeekCommand } from "../../features/cancel-week/command.js";
import { handleStatusCommand } from "../../features/status-command/index.js";
import { cheapFirstGuard, GUARD_REASON_TO_MESSAGE, buildEphemeralReject } from "./guards.js";
import type {
  AppReadyState,
  InteractionHandlerDeps,
  SendAsk
} from "./interactionHandlerDeps.js";

export type { AppReadyState, InteractionHandlerDeps, SendAsk };

const STARTUP_NOT_READY_MESSAGE = "起動処理中です。数秒待って再度お試しください。";

const buildNotReadyPayload = (): InteractionReplyOptions => ({
  content: STARTUP_NOT_READY_MESSAGE,
  flags: MessageFlags.Ephemeral
});

const logNotReadyRejection = (interaction: Interaction, reason?: string): void => {
  logger.info(
    {
      event: "interaction.rejected_not_ready",
      interactionId: interaction.id,
      userId: interaction.user?.id,
      customId: interaction.isButton() ? interaction.customId : undefined,
      commandName: interaction.isChatInputCommand() ? interaction.commandName : undefined,
      reason
    },
    "Rejected interaction because startup/reconnect is not ready."
  );
};

const handleNotReadyInteraction = async (
  interaction: Interaction,
  reason?: string
): Promise<boolean> => {
  if (interaction.isButton()) {
    await interaction.deferUpdate();
    await interaction.followUp(buildNotReadyPayload());
    logNotReadyRejection(interaction, reason);
    return true;
  }

  if (interaction.isChatInputCommand()) {
    await interaction.reply(buildNotReadyPayload());
    logNotReadyRejection(interaction, reason);
    return true;
  }

  return false;
};

const handleButton = async (
  interaction: ButtonInteraction,
  deps: InteractionHandlerDeps
): Promise<void> => {
  // why: ガード拒否理由ごとに別文言で返し、ユーザーに原因を伝える。
  const reason = cheapFirstGuard(interaction.guildId, interaction.channelId, interaction.user.id);
  if (reason) {
    await interaction.followUp(buildEphemeralReject(GUARD_REASON_TO_MESSAGE[reason]));
    return;
  }

  if (interaction.customId.startsWith("ask:")) {
    await handleAskButton(interaction, deps, { acknowledged: true });
    return;
  }

  if (interaction.customId.startsWith("postpone:")) {
    await handlePostponeButton(interaction, deps, { acknowledged: true });
    return;
  }

  if (interaction.customId.startsWith("cancel_week:")) {
    await handleCancelWeekButton(interaction, deps, { acknowledged: true });
    return;
  }

  // ack: deferUpdate() は dispatcher 入口で実行済み。stale ボタンは followUp で ephemeral 通知する。
  logger.warn(
    {
      interactionId: interaction.id,
      userId: interaction.user.id,
      customId: interaction.customId,
      reason: "unknown_or_stale_button"
    },
    "Unknown or stale button custom_id."
  );

  await interaction.followUp({
    content: rejectMessages.staleButton,
    flags: MessageFlags.Ephemeral
  });
};

export const handleInteraction = async (
  interaction: Interaction,
  deps: InteractionHandlerDeps
): Promise<void> => {
  const readyState = deps.getReadyState?.() ?? { ready: true, reason: undefined };
  if (!readyState.ready) {
    const handled = await handleNotReadyInteraction(interaction, readyState.reason);
    if (handled) {
      return;
    }
  }

  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === "ask") {
      await handleAskCommand(interaction, deps);
      return;
    }

    if (interaction.commandName === "cancel_week") {
      await handleCancelWeekCommand(interaction, deps);
      return;
    }

    if (interaction.commandName === "status") {
      await handleStatusCommand(interaction, deps);
      return;
    }

    await interaction.reply({
      content: rejectMessages.unknownCommand,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (interaction.isButton()) {
    await interaction.deferUpdate();
    await handleButton(interaction, deps);
    return;
  }

  if (interaction.isAutocomplete()) {
    return;
  }
};

export const registerInteractionHandlers = (
  client: Client,
  context: AppContext,
  options: {
    readonly getReadyState?: () => AppReadyState;
  } = {}
): void => {
  client.on("interactionCreate", (interaction) => {
    // ack: 3 秒制約に備え入口で try/catch を集約する。
    void (async () => {
      try {
        const readyDeps =
          options.getReadyState === undefined
            ? {}
            : { getReadyState: options.getReadyState };
        await handleInteraction(interaction, {
          client,
          context,
          ...readyDeps,
          sendAsk: (args) => sendAskMessage(client, { ...args, context })
        });
      } catch (err: unknown) {
        const customId = interaction.isMessageComponent() ? interaction.customId : undefined;

        logger.error(
          {
            err,
            interactionId: interaction.id,
            userId: interaction.user?.id,
            customId
          },
          "interaction handler crashed"
        );

        try {
          if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
            await interaction.reply({
              content: rejectMessages.internalError,
              flags: MessageFlags.Ephemeral
            });
          }
        } catch {
          // race: エラー通知自体の失敗は握りつぶし、二重障害で unhandled rejection を作らない。
        }
      }
    })();
  });
};
