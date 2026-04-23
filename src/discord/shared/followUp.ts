import { type ButtonInteraction, MessageFlags } from "discord.js";

import { logger } from "../../logger.js";

/**
 * Send an ephemeral follow-up message and log the outcome.
 *
 * @remarks
 * race: follow-up 失敗は本処理（DB 更新・メッセージ再描画）に影響させない。
 * Discord 一時障害時でも本処理は完了済みのため、warn ログに留めて握り潰す。
 */
export const sendEphemeralConfirmFollowUp = async (
  interaction: ButtonInteraction,
  content: string,
  logFields: Readonly<Record<string, unknown>>,
  successEvent: string,
  failMessage: string
): Promise<void> => {
  try {
    await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    logger.info(logFields, successEvent);
  } catch (err: unknown) {
    logger.warn({ err, ...logFields }, failMessage);
  }
};
