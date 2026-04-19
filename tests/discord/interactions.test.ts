import type { Client, Interaction } from "discord.js";
import { MessageFlags } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleInteraction } from "../../src/discord/interactions.js";
import { env } from "../../src/env.js";

const memberUserId = (() => {
  const userId = env.MEMBER_USER_IDS[0];
  if (!userId) {
    throw new Error("member user id is required for test setup");
  }
  return userId;
})();

const createAskInteraction = (overrides?: Partial<Record<string, unknown>>) => {
  const interaction = {
    id: "interaction-ask",
    commandName: "ask",
    guildId: env.DISCORD_GUILD_ID,
    channelId: env.DISCORD_CHANNEL_ID,
    user: { id: memberUserId },
    isChatInputCommand: () => true,
    isButton: () => false,
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined)
  };

  return { ...interaction, ...overrides };
};

const createCancelInteraction = (overrides?: Partial<Record<string, unknown>>) => {
  const interaction = {
    id: "interaction-cancel",
    commandName: "cancel_week",
    guildId: env.DISCORD_GUILD_ID,
    channelId: env.DISCORD_CHANNEL_ID,
    user: { id: memberUserId },
    isChatInputCommand: () => true,
    isButton: () => false,
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined)
  };

  return { ...interaction, ...overrides };
};

const createButtonInteraction = (customId: string, overrides?: Partial<Record<string, unknown>>) => {
  const interaction = {
    id: "interaction-button",
    customId,
    guildId: env.DISCORD_GUILD_ID,
    channelId: env.DISCORD_CHANNEL_ID,
    user: { id: memberUserId },
    isChatInputCommand: () => false,
    isButton: () => true,
    deferUpdate: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined)
  };

  return { ...interaction, ...overrides };
};

const stubClient = {} as unknown as Client;

const defaultDeps = (sendAsk: ReturnType<typeof vi.fn>) => ({
  sendAsk: sendAsk as unknown as (c: unknown) => Promise<unknown>,
  client: stubClient
}) as unknown as Parameters<typeof handleInteraction>[1];

describe("interaction router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("handles /ask success", async () => {
    const sendAsk = vi.fn(async () => ({ status: "sent" as const, weekKey: "2026-W17" }));
    const interaction = createAskInteraction();

    await handleInteraction(interaction as unknown as Interaction, defaultDeps(sendAsk));

    expect(interaction.deferReply).toHaveBeenCalledOnce();
    expect(interaction.editReply).toHaveBeenCalledWith("送信しました");
    expect(sendAsk).toHaveBeenCalledWith({
      trigger: "command",
      invokerId: memberUserId
    });
  });

  it("rejects /ask from non-members", async () => {
    const sendAsk = vi.fn(async () => ({ status: "sent" as const, weekKey: "2026-W17" }));
    const interaction = createAskInteraction({
      user: { id: "999999999999999999" }
    });

    await handleInteraction(interaction as unknown as Interaction, defaultDeps(sendAsk));

    expect(interaction.editReply).toHaveBeenCalledWith("対象外です");
    expect(sendAsk).not.toHaveBeenCalled();
  });

  it("returns failure response when /ask send throws", async () => {
    const sendAsk = vi.fn(async () => {
      throw new Error("discord api failed");
    });
    const interaction = createAskInteraction();

    await handleInteraction(interaction as unknown as Interaction, defaultDeps(sendAsk));

    expect(interaction.editReply).toHaveBeenCalledWith("送信に失敗しました");
  });

  it("keeps /cancel_week as cheap-first stub", async () => {
    const sendAsk = vi.fn(async () => ({ status: "sent" as const, weekKey: "2026-W17" }));
    const interaction = createCancelInteraction();

    await handleInteraction(interaction as unknown as Interaction, defaultDeps(sendAsk));

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "未実装です（将来 PR で実装予定）",
      flags: MessageFlags.Ephemeral
    });
  });

  it("rejects invalid ask button custom ids", async () => {
    const sendAsk = vi.fn(async () => ({ status: "sent" as const, weekKey: "2026-W17" }));
    const interaction = createButtonInteraction("ask:not-a-uuid:t2200");

    await handleInteraction(interaction as unknown as Interaction, defaultDeps(sendAsk));

    expect(interaction.deferUpdate).toHaveBeenCalledOnce();
    expect(interaction.followUp).toHaveBeenCalledWith({
      content: "未知の操作です",
      flags: MessageFlags.Ephemeral
    });
  });

  it("rejects postpone button presses with placeholder message (not-yet-implemented)", async () => {
    const sendAsk = vi.fn(async () => ({ status: "sent" as const, weekKey: "2026-W17" }));
    const interaction = createButtonInteraction(
      "postpone:4f7d54aa-3898-4a13-9f7c-5872a8220e0f:ok"
    );

    await handleInteraction(interaction as unknown as Interaction, defaultDeps(sendAsk));

    expect(interaction.followUp).toHaveBeenCalledWith({
      content: "順延投票は受付準備中です。近日公開予定です。",
      flags: MessageFlags.Ephemeral
    });
  });
});
