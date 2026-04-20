import type { Client, Interaction } from "discord.js";
import { MessageFlags } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleInteraction, registerInteractionHandlers } from "../../src/discord/dispatcher.js";
import { env } from "../../src/env.js";
import { logger } from "../../src/logger.js";
import { messages } from "../../src/messages.js";
import { memberUserId } from "../helpers/env.js";
import { buildSessionRow } from "../discord/factories/session.js";
import { createTestAppContext, type TestAppContext } from "../testing/index.js";

import {
  buildAskInteraction,
  buildButtonInteraction,
  buildCancelInteraction
} from "../helpers/interaction.js";

vi.mock("../../src/discord/ask/render.js", () => ({
  renderAskBody: vi.fn(() => ({ content: "mocked-render", components: [] })),
  buildAskRow: vi.fn()
}));

const stubClient = {} as unknown as Client;

const defaultDeps = (
  sendAsk: ReturnType<typeof vi.fn>,
  context: TestAppContext = createTestAppContext()
) => ({
  sendAsk: sendAsk as unknown as (c: unknown) => Promise<unknown>,
  client: stubClient,
  context
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

  it("records postpone vote and returns ephemeral confirmation", async () => {
    const sendAsk = vi.fn(async () => ({ status: "sent" as const, weekKey: "2026-W17" }));
    const sessionId = "4f7d54aa-3898-4a13-9f7c-5872a8220e0f";
    const session = buildSessionRow({
      id: sessionId,
      status: "POSTPONE_VOTING",
      postponeMessageId: "postpone-msg-1",
      deadlineAt: new Date("2026-04-25T15:00:00.000Z")
    });
    const members = env.MEMBER_USER_IDS.map((userId, i) => ({
      id: `member-${i}`,
      userId,
      displayName: `Member ${i}`
    }));
    const ctx = createTestAppContext({
      now: new Date("2026-04-25T12:00:00.000Z"),
      seed: { sessions: [session], members }
    });
    const interaction = buildButtonInteraction(
      `postpone:${sessionId}:ok`
    );
    const postponeMessageEdit = vi.fn(async () => undefined);
    const channelSend = vi.fn(async () => ({ id: "sent-id" }));
    const client = {
      channels: {
        fetch: vi.fn(async () => ({
          type: 0,
          isSendable: () => true,
          send: channelSend,
          messages: {
            fetch: vi.fn(async () => ({ edit: postponeMessageEdit }))
          }
        }))
      }
    } as unknown as Client;
    const messageEdit = vi.fn(async () => undefined);
    const interactionWithMessage = {
      ...interaction,
      message: { edit: messageEdit }
    };

    await handleInteraction(
      interactionWithMessage as unknown as Interaction,
      {
        sendAsk: sendAsk as unknown as Parameters<typeof handleInteraction>[1]["sendAsk"],
        client,
        context: ctx
      }
    );

    expect(interactionWithMessage.deferUpdate).toHaveBeenCalledOnce();
    expect(interactionWithMessage.followUp).toHaveBeenCalledWith({
      content: messages.interaction.voteConfirmed.postpone("ok"),
      flags: MessageFlags.Ephemeral
    });
    expect(messageEdit).toHaveBeenCalledOnce();
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

    registerInteractionHandlers(client, createTestAppContext());

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

  it("sends ephemeral vote confirmation on successful ask button press", async () => {
    const testSessionId = "4f7d54aa-3898-4a13-9f7c-5872a8220e0f";
    const session = buildSessionRow({ id: testSessionId, askMessageId: "test-msg-id" });
    const mockMembers = env.MEMBER_USER_IDS.map((userId, i) => ({
      id: `member-${i}`,
      userId,
      displayName: `Member ${i}`
    }));

    const ctx = createTestAppContext({
      seed: { sessions: [session], members: mockMembers }
    });

    const sendAsk = vi.fn(async () => ({ status: "sent" as const, weekKey: "2026-W17" }));
    const baseInteraction = buildButtonInteraction(`ask:${testSessionId}:t2200`);
    const interaction = {
      ...baseInteraction,
      message: { edit: vi.fn(async () => undefined) }
    };

    await handleInteraction(interaction as unknown as Interaction, defaultDeps(sendAsk, ctx));

    // invariant: upsertResponse は ports 経由で呼ばれ、responses 側に 1 件記録される。
    const responses = await ctx.ports.responses.listResponses(testSessionId);
    expect(responses).toHaveLength(1);
    expect(responses[0]?.choice).toBe("T2200");
    expect(responses[0]?.memberId).toBe("member-0");
    expect(interaction.message.edit).toHaveBeenCalledOnce();
    expect(interaction.followUp).toHaveBeenCalledWith({
      content: messages.interaction.voteConfirmed.ask("T2200"),
      flags: MessageFlags.Ephemeral
    });
  });
});
