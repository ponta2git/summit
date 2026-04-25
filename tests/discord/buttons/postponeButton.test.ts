import { ChannelType, MessageFlags, type Client } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { handlePostponeButton } from "../../../src/features/postpone-voting/button.js";
import type { InteractionHandlerDeps } from "../../../src/discord/shared/dispatcher.js";
import type { ResponseRow, SessionRow } from "../../../src/db/rows.js";
import { appConfig } from "../../../src/userConfig.js";
import { postponeMessages } from "../../../src/features/postpone-voting/messages.js";
import { rejectMessages } from "../../../src/features/interaction-reject/messages.js";
import { callArg } from "../../helpers/assertions.js";
import { asButtonInteraction, buildButtonInteraction } from "../../helpers/interaction.js";
import { asDiscordClient } from "../../helpers/discord.js";
import { buildSessionRow } from "../factories/session.js";
import { createTestAppContext } from "../../testing/index.js";

const seededMembers = appConfig.memberUserIds.map((userId, index) => ({
  id: `member-${index}`,
  userId,
  displayName: `Member ${index + 1}`
}));

const postponeSession = (overrides: Partial<SessionRow> = {}): SessionRow =>
  buildSessionRow({
    id: "4f7d54aa-3898-4a13-9f7c-5872a8220e0f",
    status: "POSTPONE_VOTING",
    postponeCount: 0,
    postponeMessageId: "postpone-msg-1",
    deadlineAt: new Date("2026-04-25T15:00:00.000Z"),
    ...overrides
  });

const postponeResponse = (
  index: number,
  choice: "POSTPONE_OK" | "POSTPONE_NG",
  sessionId: string
): ResponseRow => ({
  id: `response-${index}`,
  sessionId,
  memberId: seededMembers[index]!.id,
  choice,
  answeredAt: new Date(`2026-04-25T12:${String(index).padStart(2, "0")}:00.000Z`)
});

const createDiscordClient = () => {
  const postponeMessageEdit = vi.fn(async () => undefined);
  const channelSend = vi.fn(async () => ({ id: "sent-1" }));
  const channel = {
    type: ChannelType.GuildText,
    isSendable: () => true,
    send: channelSend,
    messages: {
      fetch: vi.fn(async () => ({ edit: postponeMessageEdit }))
    }
  };

  const client = asDiscordClient({
    channels: {
      fetch: vi.fn(async () => channel)
    }
  });

  return { client, postponeMessageEdit, channelSend };
};

const buildDeps = (
  context: ReturnType<typeof createTestAppContext>,
  client: Client
): InteractionHandlerDeps => ({
  context,
  client,
  sendAsk: vi.fn(async () => ({ status: "sent" as const, weekKey: "2026-W17" }))
});

describe("handlePostponeButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists OK vote and re-renders postpone message from DB", async () => {
    const session = postponeSession();
    const { client } = createDiscordClient();
    const context = createTestAppContext({
      now: new Date("2026-04-25T12:00:00.000Z"),
      seed: { sessions: [session], members: seededMembers }
    });
    const interaction = buildButtonInteraction(`postpone:${session.id}:ok`);
    const messageEdit = vi.fn(async () => undefined);
    const interactionWithMessage = { ...interaction, message: { edit: messageEdit } };

    await handlePostponeButton(
      asButtonInteraction(interactionWithMessage),
      buildDeps(context, client)
    );

    const responses = await context.ports.responses.listResponses(session.id);
    expect(responses).toHaveLength(1);
    expect(responses[0]?.memberId).toBe(seededMembers[0]!.id);
    expect(responses[0]?.choice).toBe("POSTPONE_OK");
    expect(interactionWithMessage.deferUpdate).toHaveBeenCalledOnce();
    expect(messageEdit).toHaveBeenCalledOnce();
    expect(interactionWithMessage.followUp).toHaveBeenCalledWith({
      content: postponeMessages.interaction.voteConfirmed.postpone("ok"),
      flags: MessageFlags.Ephemeral
    });
  });

  it("NG button shows ephemeral confirmation dialog (no response recorded)", async () => {
    const session = postponeSession();
    const { client } = createDiscordClient();
    const context = createTestAppContext({
      now: new Date("2026-04-25T12:00:00.000Z"),
      seed: { sessions: [session], members: seededMembers }
    });
    const interaction = buildButtonInteraction(`postpone:${session.id}:ng`);
    const interactionWithMessage = {
      ...interaction,
      message: { edit: vi.fn(async () => undefined) }
    };

    await handlePostponeButton(
      asButtonInteraction(interactionWithMessage),
      buildDeps(context, client)
    );

    // invariant: NG は確認ダイアログを経由するため、この時点では response は記録されない。
    const responses = await context.ports.responses.listResponses(session.id);
    expect(responses).toHaveLength(0);
    expect(interactionWithMessage.deferUpdate).toHaveBeenCalledOnce();
    expect(interactionWithMessage.followUp).toHaveBeenCalledOnce();
    const followUpArg = callArg<{ content: string; components: readonly unknown[]; flags: unknown }>(
      interactionWithMessage.followUp
    );
    expect(followUpArg.content).toBe(postponeMessages.ngConfirm.prompt);
    expect(followUpArg.components).toHaveLength(1);
    expect(followUpArg.flags).toBe(MessageFlags.Ephemeral);
  });

  it("NG button shows confirmation dialog even when an existing OK vote is present", async () => {
    const session = postponeSession();
    const { client } = createDiscordClient();
    const context = createTestAppContext({
      now: new Date("2026-04-25T12:00:00.000Z"),
      seed: {
        sessions: [session],
        members: seededMembers,
        responses: [postponeResponse(0, "POSTPONE_OK", session.id)]
      }
    });
    const interaction = buildButtonInteraction(`postpone:${session.id}:ng`);
    const interactionWithMessage = {
      ...interaction,
      message: { edit: vi.fn(async () => undefined) }
    };

    await handlePostponeButton(
      asButtonInteraction(interactionWithMessage),
      buildDeps(context, client)
    );

    // invariant: ダイアログ表示の段階では既存の OK 票は上書きされない。
    const responses = await context.ports.responses.listResponses(session.id);
    expect(responses).toHaveLength(1);
    expect(responses[0]?.choice).toBe("POSTPONE_OK");
    expect(interactionWithMessage.followUp).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "wrong guild",
      customId: "postpone:4f7d54aa-3898-4a13-9f7c-5872a8220e0f:ok",
      override: { guildId: "000000000000000000" },
      expectedMessage: rejectMessages.reject.wrongGuild
    },
    {
      name: "wrong channel",
      customId: "postpone:4f7d54aa-3898-4a13-9f7c-5872a8220e0f:ok",
      override: { channelId: "000000000000000000" },
      expectedMessage: rejectMessages.reject.wrongChannel
    },
    {
      name: "non-member user",
      customId: "postpone:4f7d54aa-3898-4a13-9f7c-5872a8220e0f:ok",
      override: { user: { id: "999999999999999999" } },
      expectedMessage: rejectMessages.reject.notMember
    },
    {
      name: "invalid custom_id",
      customId: "postpone:not-a-uuid:ok",
      override: {},
      expectedMessage: rejectMessages.reject.invalidCustomId
    }
  ])("rejects guard failure: $name", async ({ customId, override, expectedMessage }) => {
    const session = postponeSession();
    const { client } = createDiscordClient();
    const context = createTestAppContext({
      now: new Date("2026-04-25T12:00:00.000Z"),
      seed: { sessions: [session], members: seededMembers }
    });
    const interaction = buildButtonInteraction(customId, override);
    const interactionWithMessage = {
      ...interaction,
      message: { edit: vi.fn(async () => undefined) }
    };

    await handlePostponeButton(
      asButtonInteraction(interactionWithMessage),
      buildDeps(context, client)
    );

    expect(interactionWithMessage.deferUpdate).toHaveBeenCalledOnce();
    expect(interactionWithMessage.followUp).toHaveBeenCalledWith({
      content: expectedMessage,
      flags: MessageFlags.Ephemeral
    });
  });

  it("rejects when session is not POSTPONE_VOTING", async () => {
    const session = postponeSession({ status: "ASKING" });
    const { client } = createDiscordClient();
    const context = createTestAppContext({
      now: new Date("2026-04-25T12:00:00.000Z"),
      seed: { sessions: [session], members: seededMembers }
    });
    const interaction = buildButtonInteraction(`postpone:${session.id}:ok`);
    const interactionWithMessage = {
      ...interaction,
      message: { edit: vi.fn(async () => undefined) }
    };

    await handlePostponeButton(
      asButtonInteraction(interactionWithMessage),
      buildDeps(context, client)
    );

    expect(interactionWithMessage.followUp).toHaveBeenCalledWith({
      content: rejectMessages.reject.postponeVotingClosed,
      flags: MessageFlags.Ephemeral
    });
  });

  it("settles to POSTPONED and creates Saturday session when all 4 vote OK", async () => {
    const session = postponeSession();
    const { client, channelSend } = createDiscordClient();
    const context = createTestAppContext({
      now: new Date("2026-04-25T12:00:00.000Z"),
      seed: {
        sessions: [session],
        members: seededMembers,
        responses: [
          postponeResponse(1, "POSTPONE_OK", session.id),
          postponeResponse(2, "POSTPONE_OK", session.id),
          postponeResponse(3, "POSTPONE_OK", session.id)
        ]
      }
    });
    const interaction = buildButtonInteraction(`postpone:${session.id}:ok`);
    const interactionWithMessage = {
      ...interaction,
      message: { edit: vi.fn(async () => undefined) }
    };

    await handlePostponeButton(
      asButtonInteraction(interactionWithMessage),
      buildDeps(context, client)
    );

    const sessions = context.ports.sessions.listSessions();
    const persisted = sessions.find((row) => row.id === session.id);
    const saturday = sessions.find((row) => row.weekKey === session.weekKey && row.postponeCount === 1);
    expect(persisted?.status).toBe("POSTPONED");
    expect(saturday?.status).toBe("ASKING");
    expect(channelSend).toHaveBeenCalled();
  });
});
