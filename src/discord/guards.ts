import { MessageFlags, type ButtonInteraction } from "discord.js";

import { findSessionById } from "../db/repositories/index.js";
import type { DbLike, SessionRow } from "../db/types.js";
import { env } from "../env.js";
import { messages } from "../messages.js";

// why: cheap-first validation を統一
export const assertGuildAndChannel = (
  guildId: string | null,
  channelId: string | null
): boolean =>
  guildId === env.DISCORD_GUILD_ID &&
  channelId === env.DISCORD_CHANNEL_ID;

export const assertMember = (userId: string): boolean =>
  env.MEMBER_USER_IDS.includes(userId);

export const buildEphemeralReject = (content: string) => ({
  content,
  flags: MessageFlags.Ephemeral
} as const);

export const loadSessionOrReject = async (
  interaction: ButtonInteraction,
  db: DbLike,
  sessionId: string
): Promise<SessionRow | undefined> => {
  const session = await findSessionById(db, sessionId);
  if (!session) {
    await interaction.followUp(buildEphemeralReject(messages.interaction.reject.sessionNotFound));
    return undefined;
  }

  return session;
};
