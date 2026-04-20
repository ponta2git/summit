import type { Client, Interaction } from "discord.js";
import { MessageFlags } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleInteraction, registerInteractionHandlers } from "../../src/discord/dispatcher.js";
import { logger } from "../../src/logger.js";
import { messages } from "../../src/messages.js";
import { memberUserId } from "../helpers/env.js";

import {
  buildAskInteraction,
  buildButtonInteraction,
  buildCancelInteraction
} from "../helpers/interaction.js";

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
    const interaction = buildAskInteraction();

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
    const interaction = buildAskInteraction({
      user: { id: "999999999999999999" }
    });

    await handleInteraction(interaction as unknown as Interaction, defaultDeps(sendAsk));

    expect(interaction.editReply).toHaveBeenCalledWith(messages.interaction.reject.notMember);
    expect(sendAsk).not.toHaveBeenCalled();
  });

  it("returns failure response when /ask send throws", async () => {
    const sendAsk = vi.fn(async () => {
      throw new Error("discord api failed");
    });
    const interaction = buildAskInteraction();

    await handleInteraction(interaction as unknown as Interaction, defaultDeps(sendAsk));

    expect(interaction.editReply).toHaveBeenCalledWith("送信に失敗しました");
  });

  it("keeps /cancel_week as cheap-first stub", async () => {
    const sendAsk = vi.fn(async () => ({ status: "sent" as const, weekKey: "2026-W17" }));
    const interaction = buildCancelInteraction();

    await handleInteraction(interaction as unknown as Interaction, defaultDeps(sendAsk));

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "未実装です（将来 PR で実装予定）",
      flags: MessageFlags.Ephemeral
    });
  });

  it("rejects invalid ask button custom ids", async () => {
    const sendAsk = vi.fn(async () => ({ status: "sent" as const, weekKey: "2026-W17" }));
    const interaction = buildButtonInteraction("ask:not-a-uuid:t2200");

    await handleInteraction(interaction as unknown as Interaction, defaultDeps(sendAsk));

    expect(interaction.deferUpdate).toHaveBeenCalledOnce();
    expect(interaction.followUp).toHaveBeenCalledWith({
      content: messages.interaction.reject.invalidCustomId,
      flags: MessageFlags.Ephemeral
    });
  });

  it("rejects postpone button presses with placeholder message (not-yet-implemented)", async () => {
    const sendAsk = vi.fn(async () => ({ status: "sent" as const, weekKey: "2026-W17" }));
    const interaction = buildButtonInteraction(
      "postpone:4f7d54aa-3898-4a13-9f7c-5872a8220e0f:ok"
    );

    await handleInteraction(interaction as unknown as Interaction, defaultDeps(sendAsk));

    expect(interaction.followUp).toHaveBeenCalledWith({
      content: "順延投票は受付準備中です。近日公開予定です。",
      flags: MessageFlags.Ephemeral
    });
  });

  it("sends ephemeral feedback for unknown/stale button custom_id", async () => {
    const sendAsk = vi.fn(async () => ({ status: "sent" as const, weekKey: "2026-W17" }));
    const loggerWarnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const interaction = buildButtonInteraction("totally:unknown:id");

    await handleInteraction(interaction as unknown as Interaction, defaultDeps(sendAsk));

    expect(interaction.deferUpdate).toHaveBeenCalledOnce();
    expect(interaction.followUp).toHaveBeenCalledWith({
      content: "このボタンは現在有効ではありません。最新のメッセージから操作してください。",
      flags: MessageFlags.Ephemeral
    });
    expect(loggerWarnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        interactionId: "interaction-button",
        userId: memberUserId,
        customId: "totally:unknown:id",
        reason: "unknown_or_stale_button"
      }),
      "Unknown or stale button custom_id."
    );
    expect(sendAsk).not.toHaveBeenCalled();
  });

  it("logs and replies when interaction handler crashes in event listener", async () => {
    const on = vi.fn();
    const client = { on } as unknown as Client;
    const loggerErrorSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined);

    registerInteractionHandlers(client);

    const listener = on.mock.calls[0]?.[1] as ((interaction: Interaction) => void) | undefined;
    expect(listener).toBeTypeOf("function");
    if (!listener) {
      return;
    }

    const reply = vi.fn(async () => undefined);
    const interaction = {
      id: "interaction-crash",
      user: { id: memberUserId },
      replied: false,
      deferred: false,
      isChatInputCommand: () => {
        throw new Error("boom");
      },
      isButton: () => false,
      isMessageComponent: () => false,
      isRepliable: () => true,
      reply
    } as unknown as Interaction;

    listener(interaction);
    await new Promise((resolve) => setImmediate(resolve));

    expect(loggerErrorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        interactionId: "interaction-crash",
        userId: memberUserId,
        customId: undefined
      }),
      "interaction handler crashed"
    );
    expect(reply).toHaveBeenCalledWith({
      content: "内部エラーが発生しました。管理者に連絡してください。",
      flags: MessageFlags.Ephemeral
    });
  });

  describe("reject reason split — ephemeral messages per guard failure", () => {
    it("rejects button from wrong channel with channel-specific message", async () => {
      const sendAsk = vi.fn(async () => ({ status: "sent" as const, weekKey: "2026-W17" }));
      const interaction = buildButtonInteraction(
        "ask:4f7d54aa-3898-4a13-9f7c-5872a8220e0f:t2200",
        { channelId: "000000000000000000" }
      );

      await handleInteraction(interaction as unknown as Interaction, defaultDeps(sendAsk));

      expect(interaction.deferUpdate).toHaveBeenCalledOnce();
      expect(interaction.followUp).toHaveBeenCalledWith({
        content: messages.interaction.reject.wrongChannel,
        flags: MessageFlags.Ephemeral
      });
      expect(sendAsk).not.toHaveBeenCalled();
    });

    it("rejects button from non-member with member-specific message", async () => {
      const sendAsk = vi.fn(async () => ({ status: "sent" as const, weekKey: "2026-W17" }));
      const interaction = buildButtonInteraction(
        "ask:4f7d54aa-3898-4a13-9f7c-5872a8220e0f:t2200",
        { user: { id: "999999999999999999" } }
      );

      await handleInteraction(interaction as unknown as Interaction, defaultDeps(sendAsk));

      expect(interaction.deferUpdate).toHaveBeenCalledOnce();
      expect(interaction.followUp).toHaveBeenCalledWith({
        content: messages.interaction.reject.notMember,
        flags: MessageFlags.Ephemeral
      });
      expect(sendAsk).not.toHaveBeenCalled();
    });

    it("rejects button from wrong guild with guild-specific message", async () => {
      const sendAsk = vi.fn(async () => ({ status: "sent" as const, weekKey: "2026-W17" }));
      const interaction = buildButtonInteraction(
        "ask:4f7d54aa-3898-4a13-9f7c-5872a8220e0f:t2200",
        { guildId: "000000000000000000" }
      );

      await handleInteraction(interaction as unknown as Interaction, defaultDeps(sendAsk));

      expect(interaction.deferUpdate).toHaveBeenCalledOnce();
      expect(interaction.followUp).toHaveBeenCalledWith({
        content: messages.interaction.reject.wrongGuild,
        flags: MessageFlags.Ephemeral
      });
      expect(sendAsk).not.toHaveBeenCalled();
    });

    it("rejects cancel_week from non-member with member-specific message", async () => {
      const sendAsk = vi.fn(async () => ({ status: "sent" as const, weekKey: "2026-W17" }));
      const interaction = buildCancelInteraction({
        user: { id: "999999999999999999" }
      });

      await handleInteraction(interaction as unknown as Interaction, defaultDeps(sendAsk));

      expect(interaction.reply).toHaveBeenCalledWith({
        content: messages.interaction.reject.notMember,
        flags: MessageFlags.Ephemeral
      });
    });
  });
});
