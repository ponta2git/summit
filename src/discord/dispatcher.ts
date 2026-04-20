import {
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
  MessageFlags
} from "discord.js";

import type { DbLike } from "../db/types.js";
import { logger } from "../logger.js";
import { messages } from "../messages.js";
import { type Clock } from "../time/index.js";
import {
  sendAskMessage,
  type SendAskMessageContext,
  type SendAskMessageResult
} from "./ask/send.js";
import { handlePostponeButton } from "./buttons/postponeButton.js";
import { handleAskButton } from "./buttons/askButton.js";
import { handleAskCommand } from "./commands/ask.js";
import { cheapFirstGuard, GUARD_REASON_TO_MESSAGE, buildEphemeralReject } from "./guards.js";

type SendAsk = (context: SendAskMessageContext) => Promise<SendAskMessageResult>;

export interface InteractionHandlerDeps {
  sendAsk: SendAsk;
  client: Client;
  db?: DbLike;
  clock?: Clock;
}

const handleCancelWeekCommand = async (
  interaction: ChatInputCommandInteraction
): Promise<void> => {
  // why: UX 判断 — 拒否理由を具体的メッセージで返す
  const reason = cheapFirstGuard(interaction.guildId, interaction.channelId, interaction.user.id);
  if (reason) {
    await interaction.reply(buildEphemeralReject(GUARD_REASON_TO_MESSAGE[reason]));
    return;
  }

  await interaction.reply({
    content: messages.interaction.cancelWeek.unimplemented,
    flags: MessageFlags.Ephemeral
  });
};

const handleButton = async (
  interaction: ButtonInteraction,
  deps: InteractionHandlerDeps
): Promise<void> => {
  await interaction.deferUpdate();

  // why: UX 判断 — guild/channel/member 各ガードの拒否理由を個別メッセージで伝える
  const reason = cheapFirstGuard(interaction.guildId, interaction.channelId, interaction.user.id);
  if (reason) {
    await interaction.followUp(buildEphemeralReject(GUARD_REASON_TO_MESSAGE[reason]));
    return;
  }

  if (interaction.customId.startsWith("ask:")) {
    await handleAskButton(interaction, deps);
    return;
  }

  if (interaction.customId.startsWith("postpone:")) {
    await handlePostponeButton(interaction);
    return;
  }

  // why: 古いメッセージの stale ボタンを押したユーザーが「何も起きない」と困惑するのを防ぐ
  // ack: deferUpdate() は既に済んでいるため followUp で ephemeral 通知する
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
    content: messages.interaction.staleButton,
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

    await interaction.reply({
      content: messages.interaction.unknownCommand,
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

export const registerInteractionHandlers = (client: Client): void => {
  client.on("interactionCreate", (interaction) => {
    // ack: 3 秒制約・入口 try/catch を集約
    void (async () => {
      try {
        await handleInteraction(interaction, {
          client,
          sendAsk: (context) => sendAskMessage(client, context)
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
              content: messages.interaction.internalError,
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
