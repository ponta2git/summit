import { MessageFlags } from "discord.js";
import type { Interaction } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  handleInteraction,
  registerInteractionHandlers,
  type InteractionHandlerDeps,
  type SendAsk
} from "../../src/discord/shared/dispatcher.js";
import { appConfig } from "../../src/userConfig.js";
import { logger } from "../../src/logger.js";
import { askMessages } from "../../src/features/ask-session/messages.js";
import { cancelWeekMessages } from "../../src/features/cancel-week/messages.js";
import { postponeMessages } from "../../src/features/postpone-voting/messages.js";
import { rejectMessages } from "../../src/features/interaction-reject/messages.js";
import { callArg } from "../helpers/assertions.js";
import { asDiscordClient } from "../helpers/discord.js";
import { memberUserId } from "../helpers/env.js";
import { buildSessionRow } from "../discord/factories/session.js";
import { createTestAppContext, type TestAppContext } from "../testing/index.js";

import {
  buildAskInteraction,
  asInteraction,
  buildButtonInteraction,
  buildCancelInteraction
} from "../helpers/interaction.js";

// why: render は pure builder (ADR-0028) なので stub 不要。Fake ports の state を直接検証する。
const stubClient = asDiscordClient({});

const defaultDeps = (
  sendAsk: ReturnType<typeof vi.fn>,
  context: TestAppContext = createTestAppContext()
) : InteractionHandlerDeps => ({
  sendAsk: sendAsk as SendAsk,
  client: stubClient,
  context
});

describe("interaction router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("handles /ask success", async () => {
    const sendAsk = vi.fn(async () => ({ status: "sent" as const, weekKey: "2026-W17" }));
    const interaction = buildAskInteraction();

    await handleInteraction(asInteraction(interaction), defaultDeps(sendAsk));

    expect(interaction.deferReply).toHaveBeenCalledOnce();
    expect(interaction.editReply).toHaveBeenCalledWith(askMessages.interaction.ask.sent);
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

    await handleInteraction(asInteraction(interaction), defaultDeps(sendAsk));

    expect(interaction.editReply).toHaveBeenCalledWith(rejectMessages.reject.notMember);
    expect(sendAsk).not.toHaveBeenCalled();
  });

  it("returns failure response when /ask send throws", async () => {
    const sendAsk = vi.fn(async () => {
      throw new Error("discord api failed");
    });
    const interaction = buildAskInteraction();

    await handleInteraction(asInteraction(interaction), defaultDeps(sendAsk));

    expect(interaction.editReply).toHaveBeenCalledWith(askMessages.interaction.ask.failed);
  });

  it("opens /cancel_week confirmation dialog", async () => {
    const sendAsk = vi.fn(async () => ({ status: "sent" as const, weekKey: "2026-W17" }));
    const interaction = buildCancelInteraction();

    await handleInteraction(asInteraction(interaction), defaultDeps(sendAsk));

    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    const payload = callArg<{ content: string; components: readonly unknown[] }>(
      interaction.editReply
    );
    expect(payload.content).toBe(cancelWeekMessages.cancelWeek.confirmPrompt);
    expect(payload.components).toHaveLength(1);
  });

  it("rejects invalid ask button custom ids", async () => {
    const sendAsk = vi.fn(async () => ({ status: "sent" as const, weekKey: "2026-W17" }));
    const interaction = buildButtonInteraction("ask:not-a-uuid:t2200");

    await handleInteraction(asInteraction(interaction), defaultDeps(sendAsk));

    expect(interaction.deferUpdate).toHaveBeenCalledOnce();
    expect(interaction.followUp).toHaveBeenCalledWith({
      content: rejectMessages.reject.invalidCustomId,
      flags: MessageFlags.Ephemeral
    });
  });

  it("records postpone vote and relies on public message update for feedback", async () => {
    const sendAsk = vi.fn(async () => ({ status: "sent" as const, weekKey: "2026-W17" }));
    const sessionId = "4f7d54aa-3898-4a13-9f7c-5872a8220e0f";
    const session = buildSessionRow({
      id: sessionId,
      status: "POSTPONE_VOTING",
      postponeMessageId: "postpone-msg-1",
      deadlineAt: new Date("2026-04-25T15:00:00.000Z")
    });
    const members = appConfig.memberUserIds.map((userId, i) => ({
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
    const client = asDiscordClient({
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
    });
    const messageEdit = vi.fn(async () => undefined);
    const interactionWithMessage = {
      ...interaction,
      message: { edit: messageEdit }
    };

    await handleInteraction(
      asInteraction(interactionWithMessage),
      {
        sendAsk: sendAsk as SendAsk,
        client,
        context: ctx
      }
    );

    expect(interactionWithMessage.deferUpdate).toHaveBeenCalledOnce();
    expect(interactionWithMessage.followUp).not.toHaveBeenCalled();
    expect(messageEdit).toHaveBeenCalledOnce();
  });

  it("sends ephemeral feedback for unknown/stale button custom_id", async () => {
    const sendAsk = vi.fn(async () => ({ status: "sent" as const, weekKey: "2026-W17" }));
    const loggerWarnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const interaction = buildButtonInteraction("totally:unknown:id");

    await handleInteraction(asInteraction(interaction), defaultDeps(sendAsk));

    expect(interaction.deferUpdate).toHaveBeenCalledOnce();
    expect(interaction.followUp).toHaveBeenCalledWith({
      content: rejectMessages.staleButton,
      flags: MessageFlags.Ephemeral
    });
    const warnFields = callArg<Record<string, unknown>>(loggerWarnSpy);
    expect({
      interactionId: warnFields["interactionId"],
      userId: warnFields["userId"],
      customId: warnFields["customId"],
      reason: warnFields["reason"],
      message: callArg<string>(loggerWarnSpy, 0, 1)
    }).toStrictEqual({
      interactionId: "interaction-button",
      userId: memberUserId,
      customId: "totally:unknown:id",
      reason: "unknown_or_stale_button",
      message: "Unknown or stale button custom_id."
    });
    expect(sendAsk).not.toHaveBeenCalled();
  });

  it("logs and replies when interaction handler crashes in event listener", async () => {
    const on = vi.fn();
    const client = asDiscordClient({ on });
    const loggerErrorSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined);

    registerInteractionHandlers(client, createTestAppContext());

    const listener = callArg<(interaction: Interaction) => void>(on, 0, 1);
    expect(listener).toBeTypeOf("function");

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
    };

    listener(asInteraction(interaction));
    await new Promise((resolve) => setImmediate(resolve));

    const errorFields = callArg<Record<string, unknown>>(loggerErrorSpy);
    expect(errorFields["err"]).toBeInstanceOf(Error);
    expect({
      interactionId: errorFields["interactionId"],
      userId: errorFields["userId"],
      customId: errorFields["customId"],
      message: callArg<string>(loggerErrorSpy, 0, 1)
    }).toStrictEqual({
      interactionId: "interaction-crash",
      userId: memberUserId,
      customId: undefined,
      message: "interaction handler crashed"
    });
    expect(reply).toHaveBeenCalledWith({
      content: rejectMessages.internalError,
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

      await handleInteraction(asInteraction(interaction), defaultDeps(sendAsk));

      expect(interaction.deferUpdate).toHaveBeenCalledOnce();
      expect(interaction.followUp).toHaveBeenCalledWith({
        content: rejectMessages.reject.wrongChannel,
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

      await handleInteraction(asInteraction(interaction), defaultDeps(sendAsk));

      expect(interaction.deferUpdate).toHaveBeenCalledOnce();
      expect(interaction.followUp).toHaveBeenCalledWith({
        content: rejectMessages.reject.notMember,
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

      await handleInteraction(asInteraction(interaction), defaultDeps(sendAsk));

      expect(interaction.deferUpdate).toHaveBeenCalledOnce();
      expect(interaction.followUp).toHaveBeenCalledWith({
        content: rejectMessages.reject.wrongGuild,
        flags: MessageFlags.Ephemeral
      });
      expect(sendAsk).not.toHaveBeenCalled();
    });

    it("rejects cancel_week from non-member with member-specific message", async () => {
      const sendAsk = vi.fn(async () => ({ status: "sent" as const, weekKey: "2026-W17" }));
      const interaction = buildCancelInteraction({
        user: { id: "999999999999999999" }
      });

      await handleInteraction(asInteraction(interaction), defaultDeps(sendAsk));

      expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
      expect(interaction.editReply).toHaveBeenCalledWith(rejectMessages.reject.notMember);
    });
  });

  it("records ask vote and relies on public message update for feedback", async () => {
    const testSessionId = "4f7d54aa-3898-4a13-9f7c-5872a8220e0f";
    const session = buildSessionRow({ id: testSessionId, askMessageId: "test-msg-id" });
    const mockMembers = appConfig.memberUserIds.map((userId, i) => ({
      id: `member-${i}`,
      userId,
      displayName: `Member ${i}`
    }));

    const ctx = createTestAppContext({
      now: new Date("2026-04-24T10:00:00.000Z"), // before deadlineAt 12:30Z
      seed: { sessions: [session], members: mockMembers }
    });

    const sendAsk = vi.fn(async () => ({ status: "sent" as const, weekKey: "2026-W17" }));
    const baseInteraction = buildButtonInteraction(`ask:${testSessionId}:t2200`);
    const interaction = {
      ...baseInteraction,
      message: { edit: vi.fn(async () => undefined) }
    };

    await handleInteraction(asInteraction(interaction), defaultDeps(sendAsk, ctx));

    // invariant: upsertResponse は ports 経由で呼ばれ responses に 1 件記録される。
    const responses = await ctx.ports.responses.listResponses(testSessionId);
    expect(responses).toHaveLength(1);
    expect(responses[0]?.choice).toBe("T2200");
    expect(responses[0]?.memberId).toBe("member-0");
    expect(interaction.message.edit).toHaveBeenCalledOnce();
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  it("shows ephemeral absent confirmation dialog on absent button press (no response recorded)", async () => {
    const testSessionId = "4f7d54aa-3898-4a13-9f7c-5872a8220e0f";
    const session = buildSessionRow({ id: testSessionId, askMessageId: "test-msg-id" });
    const mockMembers = appConfig.memberUserIds.map((userId, i) => ({
      id: `member-${i}`,
      userId,
      displayName: `Member ${i}`
    }));

    const ctx = createTestAppContext({
      now: new Date("2026-04-24T10:00:00.000Z"), // before deadlineAt 12:30Z
      seed: { sessions: [session], members: mockMembers }
    });

    const sendAsk = vi.fn(async () => ({ status: "sent" as const, weekKey: "2026-W17" }));
    const interaction = buildButtonInteraction(`ask:${testSessionId}:absent`);

    await handleInteraction(asInteraction(interaction), defaultDeps(sendAsk, ctx));

    // invariant: 欠席は確認ダイアログを経由するため、この時点では response は記録されない。
    const responses = await ctx.ports.responses.listResponses(testSessionId);
    expect(responses).toHaveLength(0);
    expect(interaction.deferUpdate).toHaveBeenCalledOnce();
    const followUpCall = callArg<{ content: string; components: readonly unknown[]; flags: unknown }>(
      interaction.followUp
    );
    expect(followUpCall.content).toBe(askMessages.absentConfirm.prompt);
    expect(followUpCall.components).toHaveLength(1);
    expect(followUpCall.flags).toBe(MessageFlags.Ephemeral);
  });

  it("shows ephemeral NG confirmation dialog on postpone NG button press (no response recorded)", async () => {
    const testSessionId = "4f7d54aa-3898-4a13-9f7c-5872a8220e0f";
    const session = buildSessionRow({
      id: testSessionId,
      status: "POSTPONE_VOTING",
      postponeMessageId: "postpone-msg-1",
      deadlineAt: new Date("2026-04-25T15:00:00.000Z")
    });
    const mockMembers = appConfig.memberUserIds.map((userId, i) => ({
      id: `member-${i}`,
      userId,
      displayName: `Member ${i}`
    }));

    const ctx = createTestAppContext({
      now: new Date("2026-04-25T12:00:00.000Z"), // before deadlineAt 15:00Z
      seed: { sessions: [session], members: mockMembers }
    });

    const sendAsk = vi.fn(async () => ({ status: "sent" as const, weekKey: "2026-W17" }));
    const interaction = buildButtonInteraction(`postpone:${testSessionId}:ng`);

    await handleInteraction(asInteraction(interaction), defaultDeps(sendAsk, ctx));

    // invariant: NG は確認ダイアログを経由するため、この時点では response は記録されない。
    const responses = await ctx.ports.responses.listResponses(testSessionId);
    expect(responses).toHaveLength(0);
    expect(interaction.deferUpdate).toHaveBeenCalledOnce();
    const ngFollowUpCall = callArg<{
      content: string;
      components: readonly unknown[];
      flags: unknown;
    }>(interaction.followUp);
    expect(ngFollowUpCall.content).toBe(postponeMessages.ngConfirm.prompt);
    expect(ngFollowUpCall.components).toHaveLength(1);
    expect(ngFollowUpCall.flags).toBe(MessageFlags.Ephemeral);
  });
});
