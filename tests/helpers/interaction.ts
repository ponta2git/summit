import { vi } from "vitest";

import { env } from "../../src/env.js";
import { memberUserId } from "./env.js";

// why: interaction factory を narrow override 型で束ねることで
//   tests/discord/interactions.test.ts に散らばっていた 3 factory を共通化する。
//   Partial<Record<string, unknown>> の緩い override を廃し、
//   実際に override される場面 (user.id の差し替え等) に型を合わせる。
// @see tests/strategy review P2-b

type AskOverride = {
  readonly user?: { readonly id: string };
  readonly guildId?: string | null;
  readonly channelId?: string | null;
};

type CancelOverride = AskOverride;

type ButtonOverride = AskOverride;

export const buildAskInteraction = (override: AskOverride = {}) => ({
  id: "interaction-ask",
  commandName: "ask",
  guildId: override.guildId ?? env.DISCORD_GUILD_ID,
  channelId: override.channelId ?? env.DISCORD_CHANNEL_ID,
  user: override.user ?? { id: memberUserId },
  isChatInputCommand: () => true,
  isButton: () => false,
  deferReply: vi.fn(async () => undefined),
  editReply: vi.fn(async () => undefined),
  reply: vi.fn(async () => undefined)
});

export const buildCancelInteraction = (override: CancelOverride = {}) => ({
  id: "interaction-cancel",
  commandName: "cancel_week",
  guildId: override.guildId ?? env.DISCORD_GUILD_ID,
  channelId: override.channelId ?? env.DISCORD_CHANNEL_ID,
  user: override.user ?? { id: memberUserId },
  isChatInputCommand: () => true,
  isButton: () => false,
  deferReply: vi.fn(async () => undefined),
  editReply: vi.fn(async () => undefined),
  reply: vi.fn(async () => undefined)
});

export const buildButtonInteraction = (customId: string, override: ButtonOverride = {}) => ({
  id: "interaction-button",
  customId,
  guildId: override.guildId ?? env.DISCORD_GUILD_ID,
  channelId: override.channelId ?? env.DISCORD_CHANNEL_ID,
  user: override.user ?? { id: memberUserId },
  isChatInputCommand: () => false,
  isButton: () => true,
  deferUpdate: vi.fn(async () => undefined),
  followUp: vi.fn(async () => undefined),
  reply: vi.fn(async () => undefined)
});
