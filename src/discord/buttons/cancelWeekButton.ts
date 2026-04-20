import { MessageFlags, type ButtonInteraction } from "discord.js";

import { logger } from "../../logger.js";
import { messages } from "../../messages.js";
import { applyManualSkip } from "../settle/skipWeek.js";
import { parseCancelWeekCustomId } from "../customId.js";
import { assertGuildAndChannel, assertMember } from "../guards.js";
import type { InteractionHandlerDeps } from "../dispatcher.js";

/**
 * Handle cancel_week confirm/abort button from the ephemeral confirmation dialog.
 *
 * @remarks
 * 確認ダイアログは ephemeral なので押せるのは実行者のみだが、invariant として cheap-first guard を
 * 再評価する。abort は単に ephemeral を更新するだけ、confirm は applyManualSkip で週全体の SKIPPED 遷移を
 * 行う。
 * @see docs/adr/0023-cancel-week-command-flow.md
 */
export const handleCancelWeekButton = async (
  interaction: ButtonInteraction,
  deps: InteractionHandlerDeps
): Promise<void> => {
  // ack: ephemeral confirmation の更新は update() で原子的に行う（deferUpdate はこの関数の中で行う）。
  await interaction.deferUpdate();

  // invariant: cheap-first. guild/channel/member は dispatcher 側でも検証済みだが、
  //   confirmation dialog でも念のため再評価（防御的多重化）。
  if (
    !assertGuildAndChannel(interaction.guildId, interaction.channelId) ||
    !assertMember(interaction.user.id)
  ) {
    await interaction.followUp({
      content: messages.interaction.reject.notMember,
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
      content: messages.interaction.reject.invalidCustomId,
      components: []
    });
    return;
  }

  const { choice } = parsed.data;

  if (choice === "abort") {
    await interaction.editReply({
      content: messages.interaction.cancelWeek.aborted,
      components: []
    });
    logger.info(
      { interactionId: interaction.id, userId: interaction.user.id },
      "cancel_week aborted by invoker."
    );
    return;
  }

  // choice === "confirm"
  const outcome = await applyManualSkip(deps.client, deps.context, {
    invokerUserId: interaction.user.id
  });

  await interaction.editReply({
    content: messages.interaction.cancelWeek.done({ count: outcome.skippedCount }),
    components: []
  });
};
