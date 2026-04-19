import {
  type Client,
  MessageFlags,
  type ChatInputCommandInteraction,
  type Interaction,
  type ButtonInteraction
} from "discord.js";
import { z } from "zod";

import { env } from "../env.js";
import { logger } from "../logger.js";
import { sendAskMessage, type SendAskMessageContext, type SendAskMessageResult } from "./askMessage.js";

const askCustomIdSchema = z
  .string()
  .regex(
    /^ask:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:(t2200|t2230|t2300|t2330|absent)$/
  );

type SendAsk = (context: SendAskMessageContext) => Promise<SendAskMessageResult>;

export interface InteractionHandlerDeps {
  sendAsk: SendAsk;
}

const isAllowedActor = (guildId: string | null, channelId: string, userId: string): boolean =>
  guildId === env.DISCORD_GUILD_ID &&
  channelId === env.DISCORD_CHANNEL_ID &&
  env.MEMBER_USER_IDS.includes(userId);

const rejectMessage = "対象外です";

const handleAskCommand = async (
  interaction: ChatInputCommandInteraction,
  deps: InteractionHandlerDeps
): Promise<void> => {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!isAllowedActor(interaction.guildId, interaction.channelId, interaction.user.id)) {
    await interaction.editReply(rejectMessage);
    return;
  }

  try {
    const result = await deps.sendAsk({
      trigger: "command",
      invokerId: interaction.user.id
    });

    if (result.status === "sent") {
      await interaction.editReply("送信しました");
      return;
    }

    await interaction.editReply("本週は既に送信済みのためスキップしました");
  } catch (error: unknown) {
    logger.error(
      {
        error,
        interactionId: interaction.id,
        userId: interaction.user.id
      },
      "Failed to execute /ask."
    );
    await interaction.editReply("送信に失敗しました");
  }
};

const handleCancelWeekCommand = async (interaction: ChatInputCommandInteraction): Promise<void> => {
  if (!isAllowedActor(interaction.guildId, interaction.channelId, interaction.user.id)) {
    await interaction.reply({
      content: rejectMessage,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  await interaction.reply({
    content: "未実装です（将来 PR で実装予定）",
    flags: MessageFlags.Ephemeral
  });
};

const handleButton = async (interaction: ButtonInteraction): Promise<void> => {
  await interaction.deferUpdate();

  if (!isAllowedActor(interaction.guildId, interaction.channelId, interaction.user.id)) {
    await interaction.followUp({
      content: "このボタンは対象外です",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const parsed = askCustomIdSchema.safeParse(interaction.customId);
  if (!parsed.success) {
    logger.warn(
      {
        interactionId: interaction.id,
        userId: interaction.user.id
      },
      "Invalid custom_id for ask button."
    );
    await interaction.followUp({
      content: "未知の操作です",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  await interaction.followUp({
    content: "まだ受付準備中です。受付機能は近日公開予定です。",
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
      content: "未対応コマンドです",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (interaction.isButton()) {
    await handleButton(interaction);
  }
};

export const registerInteractionHandlers = (client: Client): void => {
  client.on("interactionCreate", (interaction) => {
    void handleInteraction(interaction, {
      sendAsk: (context) => sendAskMessage(client, context)
    });
  });
};
