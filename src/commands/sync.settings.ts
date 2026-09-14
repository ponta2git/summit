import type { SyncOptions } from "./sync.protocol.ts";

export interface SyncSettings extends SyncOptions {
  readonly token: string;
  readonly applicationId: string;
  readonly guildId: string;
}

const validId = (value: unknown): value is string => typeof value === "string" && /^\d{17,20}$/.test(value);

export const readSyncSettings = async (
  options: SyncOptions, environment: Readonly<NodeJS.ProcessEnv>
): Promise<SyncSettings | undefined> => {
  const token = environment["DISCORD_TOKEN"];
  if (!token || token.trim() !== token || /\s/.test(token)) { return undefined; }
  let applicationId = environment["DISCORD_APPLICATION_ID"];
  let guildId = environment["DISCORD_GUILD_ID"];
  if (!options.production) {
    // compat: 開発用 command は従来の token / YAML 入力を維持。本番は明示した ID のみ。
    applicationId ??= Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf8");
    if (guildId === undefined) {
      try {
        const { parse } = await import("yaml");
        const config: unknown = parse(environment["SUMMIT_CONFIG_YAML"] ?? "");
        if (typeof config === "object" && config !== null && "discord" in config) {
          const discord = config.discord;
          if (typeof discord === "object" && discord !== null && "guildId" in discord && validId(discord.guildId)) { guildId = discord.guildId; }
        }
      } catch { return undefined; }
    }
  }
  if (!validId(applicationId) || !validId(guildId)) { return undefined; }
  return { ...options, token, applicationId, guildId };
};
