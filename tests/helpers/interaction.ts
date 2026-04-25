import { vi } from "vitest";
import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  Interaction
} from "discord.js";

import { appConfig } from "../../src/userConfig.js";
import { memberUserId } from "./env.js";

// why: interaction factory を narrow override 型で束ねることで
//   tests/discord/interactions.test.ts に散らばっていた 3 factory を共通化する。
//   Partial<Record<string, unknown>> の緩い override を廃し、
//   実際に override される場面 (user.id の差し替え等) に型を合わせる。

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
  guildId: override.guildId ?? appConfig.discord.guildId,
  channelId: override.channelId ?? appConfig.discord.channelId,
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
  guildId: override.guildId ?? appConfig.discord.guildId,
  channelId: override.channelId ?? appConfig.discord.channelId,
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
  guildId: override.guildId ?? appConfig.discord.guildId,
  channelId: override.channelId ?? appConfig.discord.channelId,
  user: override.user ?? { id: memberUserId },
  isChatInputCommand: () => false,
  isButton: () => true,
  deferUpdate: vi.fn(async () => undefined),
  editReply: vi.fn(async () => undefined),
  followUp: vi.fn(async () => undefined),
  reply: vi.fn(async () => undefined)
});

export const asInteraction = (interaction: unknown): Interaction =>
  interaction as unknown as Interaction;

export const asChatInputCommandInteraction = (
  interaction: unknown
): ChatInputCommandInteraction =>
  interaction as unknown as ChatInputCommandInteraction;

export const asButtonInteraction = (interaction: unknown): ButtonInteraction =>
  interaction as unknown as ButtonInteraction;
