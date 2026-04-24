import { MessageFlags, type ButtonInteraction } from "discord.js";

import { logger } from "../../logger.js";
import { cancelWeekMessages } from "./messages.js";
import { rejectMessages } from "../interaction-reject/messages.js";
import { applyManualSkip } from "./settle.js";
import { parseCancelWeekCustomId } from "../../discord/shared/customId.js";
import { assertGuildAndChannel, assertMember } from "../../discord/shared/guards.js";
import type { InteractionHandlerDeps } from "../../discord/shared/dispatcher.js";

/**
 * Handle cancel_week confirm/abort button from the ephemeral confirmation dialog.
 *
 * @remarks
 * 確認ダイアログは ephemeral で実行者のみ押下可。confirm で週全体を SKIPPED に遷移、abort は dialog 更新のみ。
 * cheap-first guard は dispatcher 側でも実施済みだが防御的に再評価する。
 * @see ADR-0023
 */
export const handleCancelWeekButton = async (
  interaction: ButtonInteraction,
  deps: InteractionHandlerDeps,
  options: {
    readonly acknowledged?: boolean;
  } = {}
): Promise<void> => {
  if (!options.acknowledged) {
    // ack: ephemeral confirmation の更新のため入口で deferUpdate する。
    await interaction.deferUpdate();
  }

  // invariant: cheap-first 順 (guild/channel → member)
  if (
    !assertGuildAndChannel(interaction.guildId, interaction.channelId) ||
    !assertMember(interaction.user.id)
  ) {
    await interaction.followUp({
      content: rejectMessages.reject.notMember,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const parsed = parseCancelWeekCustomId(interaction.customId);
  if (!parsed.success) {
    logger.warn(
      { interactionId: interaction.id, customId: interaction.customId },
      "Invalid cancel_week custom_id."
    );
    await interaction.editReply({
      content: rejectMessages.reject.invalidCustomId,
      components: []
    });
    return;
  }

  const { choice } = parsed.data;

  if (choice === "abort") {
    await interaction.editReply({
      content: cancelWeekMessages.cancelWeek.aborted,
      components: []
    });
    logger.info(
      { interactionId: interaction.id, userId: interaction.user.id },
      "cancel_week aborted by invoker."
    );
    return;
  }

  const outcome = await applyManualSkip(deps.client, deps.context, {
    invokerUserId: interaction.user.id
  });

  await interaction.editReply({
    content: cancelWeekMessages.cancelWeek.done({ count: outcome.skippedCount }),
    components: []
  });
};
