import { MessageFlags, type ButtonInteraction } from "discord.js";

import { logger } from "../../logger.js";
import { messages } from "../../messages.js";
import { parseCustomId } from "../customId.js";

export const handlePostponeButton = async (interaction: ButtonInteraction): Promise<void> => {
  const parsed = parseCustomId(interaction.customId);
  if (!parsed.success || parsed.data.kind !== "postpone") {
    logger.warn(
      { interactionId: interaction.id, userId: interaction.user.id },
      "Invalid custom_id for postpone button."
    );
    await interaction.followUp({
      content: messages.interaction.reject.invalidCustomId,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  // source-of-truth: postpone 判定の正本は DB state machine。現時点は placeholder 応答のみ。
  // race: postpone 投票実装時も同時押下を前提に transaction + CAS で扱う。
  // idempotent: 現状は状態変更せず固定メッセージ返却のみのため重複押下でも結果は同一。
  // todo(ai): postpone 投票の本実装時に messages.interaction.voteConfirmed.postpone を使った
  //   ephemeral 確認フィードバックを success branch に追加する (askButton.ts を参照)。
  await interaction.followUp({
    content: messages.interaction.postpone.pending,
    flags: MessageFlags.Ephemeral
  });
};
