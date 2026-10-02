import type { MessageMentionOptions } from "discord.js";

/** Allow only the intended members, including when untrusted labels contain mentions. */
export const memberMentions = (
  memberUserIds: readonly string[],
  suppressMentions: boolean
): MessageMentionOptions => ({
  parse: [],
  users: suppressMentions ? [] : [...memberUserIds],
  roles: [],
  repliedUser: false
});
