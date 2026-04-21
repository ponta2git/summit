// why: Discord API error の type narrowing を reconciler / messageEditor から共有する。
//   直接 reconciler ↔ messageEditor で import しあうと循環依存になるため中立のモジュールに切り出す。
// @see docs/adr/0033-startup-invariant-reconciler.md

// why: discord.js が投げる DiscordAPIError の code で "Unknown Message" を判別する。
//   定数値は discord-api-types RESTJSONErrorCodes.UnknownMessage (10008) に一致。
//   直接 import すると transitive dep に依存するため数値で固定する。
// @see https://discord.com/developers/docs/topics/opcodes-and-status-codes#json
export const DISCORD_UNKNOWN_MESSAGE_CODE = 10008;

export const isUnknownMessageError = (error: unknown): boolean => {
  if (error === null || typeof error !== "object") {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === DISCORD_UNKNOWN_MESSAGE_CODE;
};
