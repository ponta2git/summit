import {
  type ButtonInteraction,
  type Client,
  type Interaction,
  MessageFlags
} from "discord.js";

import type { AppContext } from "../../appContext.js";
import { logger } from "../../logger.js";
import { rejectMessages } from "../../features/interaction-reject/messages.js";
import {
  sendAskMessage,
  type SendAskMessageResult
} from "../../features/ask-session/send.js";
import { handlePostponeButton } from "../../features/postpone-voting/button.js";
import { handleAskButton } from "../../features/ask-session/button.js";
import { handleCancelWeekButton } from "../../features/cancel-week/button.js";
import { handleAskCommand } from "../../features/ask-session/command.js";
import { handleCancelWeekCommand } from "../../features/cancel-week/command.js";
import { handleStatusCommand } from "../../features/status-command/index.js";
import { cheapFirstGuard, GUARD_REASON_TO_MESSAGE, buildEphemeralReject } from "./guards.js";

export type SendAsk = (args: {
  readonly trigger: "cron" | "command";
  readonly invokerId?: string;
}) => Promise<SendAskMessageResult>;

export interface InteractionHandlerDeps {
  readonly sendAsk: SendAsk;
  readonly client: Client;
  readonly context: AppContext;
}

const handleButton = async (
  interaction: ButtonInteraction,
  deps: InteractionHandlerDeps
): Promise<void> => {
  // why: UX 判断 — guild/channel/member 各ガードの拒否理由を個別メッセージで伝える
  const reason = cheapFirstGuard(interaction.guildId, interaction.channelId, interaction.user.id);
  if (reason) {
    await interaction.deferUpdate();
    await interaction.followUp(buildEphemeralReject(GUARD_REASON_TO_MESSAGE[reason]));
    return;
  }

  if (interaction.customId.startsWith("ask:")) {
    await interaction.deferUpdate();
    await handleAskButton(interaction, deps);
    return;
  }

  if (interaction.customId.startsWith("postpone:")) {
    await handlePostponeButton(interaction, deps);
    return;
  }

  if (interaction.customId.startsWith("cancel_week:")) {
    await handleCancelWeekButton(interaction, deps);
    return;
  }

  // why: 古いメッセージの stale ボタンを押したユーザーが「何も起きない」と困惑するのを防ぐ
  // ack: deferUpdate() は既に済んでいるため followUp で ephemeral 通知する
  await interaction.deferUpdate();
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
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === "ask") {
      await handleAskCommand(interaction, deps);
      return;
    }

    if (interaction.commandName === "cancel_week") {
      await handleCancelWeekCommand(interaction);
      return;
    }

    if (interaction.commandName === "status") {
      await handleStatusCommand(interaction, deps.context);
      return;
    }

    await interaction.reply({
      content: rejectMessages.unknownCommand,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (interaction.isButton()) {
    await handleButton(interaction, deps);
    return;
  }

  if (interaction.isAutocomplete()) {
    return;
  }
};

export const registerInteractionHandlers = (client: Client, context: AppContext): void => {
  client.on("interactionCreate", (interaction) => {
    // ack: 3 秒制約・入口 try/catch を集約
    void (async () => {
      try {
        await handleInteraction(interaction, {
          client,
          context,
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
          // invariant: エラー通知自体の失敗は握りつぶし、二重障害で unhandled rejection を作らない。
        }
      }
    })();
  });
};
