// why: discord.js の DiscordAPIError.code で "Unknown Message" (10008) を判別。
//   discord-api-types を transitive dep に依存させないため数値固定。
// @see https://discord.com/developers/docs/topics/opcodes-and-status-codes#json
export const DISCORD_UNKNOWN_MESSAGE_CODE = 10008;

export const isUnknownMessageError = (error: unknown): boolean => {
  if (error === null || typeof error !== "object") {
    return false;
  }
  const code = "code" in error ? error.code : undefined;
  return code === DISCORD_UNKNOWN_MESSAGE_CODE;
};
