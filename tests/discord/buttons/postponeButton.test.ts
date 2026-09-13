import { MessageFlags } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import { handlePostponeButton } from "../../../src/features/postpone-voting/button.js";
import { postponeMessages } from "../../../src/features/postpone-voting/messages.js";
import { rejectMessages } from "../../../src/features/interaction-reject/messages.js";
import { callArg } from "../../helpers/assertions.js";
import { asButtonInteraction, buildButtonInteraction } from "../../helpers/interaction.js";
import { createTestAppContext } from "../../testing/index.js";
import {
  buildDeps,
  createDiscordClient,
  postponeResponse,
  postponeSession,
  seededMembers
} from "./postponeButton.harness.js";

describe("handlePostponeButton", () => {
  it("persists OK vote and re-renders postpone message from DB", async () => {
    const session = postponeSession();
    const { client } = createDiscordClient();
    const now = new Date("2026-04-24T12:00:00.000Z");
    const context = createTestAppContext({
      now,
      seed: { sessions: [session], members: seededMembers }
    });
    const interaction = buildButtonInteraction(`postpone:${session.id}:ok`);
    const messageEdit = vi.fn(async () => undefined);
    const interactionWithMessage = { ...interaction, message: { id: session.postponeMessageId, edit: messageEdit } };

    await handlePostponeButton(
      asButtonInteraction(interactionWithMessage),
      buildDeps(context, client)
    );

    const responses = await context.ports.responses.listResponses(session.id);
    expect(responses.map((response) => ({
      sessionId: response.sessionId,
      memberId: response.memberId,
      choice: response.choice,
      answeredAt: response.answeredAt
    }))).toStrictEqual([{
      sessionId: session.id,
      memberId: seededMembers[0]!.id,
      choice: "POSTPONE_OK",
      answeredAt: now
    }]);
    expect(interactionWithMessage.deferUpdate).toHaveBeenCalledOnce();
    expect(messageEdit).toHaveBeenCalledOnce();
    expect(interactionWithMessage.followUp).not.toHaveBeenCalled();
  });

  it("NG button shows ephemeral confirmation dialog (no response recorded)", async () => {
    const session = postponeSession();
    const { client } = createDiscordClient();
    const context = createTestAppContext({
      now: new Date("2026-04-24T12:00:00.000Z"),
      seed: { sessions: [session], members: seededMembers }
    });
    const interaction = buildButtonInteraction(`postpone:${session.id}:ng`);
    const interactionWithMessage = {
      ...interaction,
      message: { id: session.postponeMessageId, edit: vi.fn(async () => undefined) }
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
      now: new Date("2026-04-24T12:00:00.000Z"),
      seed: {
        sessions: [session],
        members: seededMembers,
        responses: [postponeResponse(0, "POSTPONE_OK", session.id)]
      }
    });
    const interaction = buildButtonInteraction(`postpone:${session.id}:ng`);
    const interactionWithMessage = {
      ...interaction,
      message: { id: session.postponeMessageId, edit: vi.fn(async () => undefined) }
    };

    await handlePostponeButton(
      asButtonInteraction(interactionWithMessage),
      buildDeps(context, client)
    );

    // invariant: ダイアログ表示の段階では既存の OK 票は上書きされない。
    expect(await context.ports.responses.listResponses(session.id)).toStrictEqual([
      postponeResponse(0, "POSTPONE_OK", session.id)
    ]);
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
      now: new Date("2026-04-24T12:00:00.000Z"),
      seed: { sessions: [session], members: seededMembers }
    });
    const interaction = buildButtonInteraction(customId, override);
    const interactionWithMessage = {
      ...interaction,
      message: { id: session.postponeMessageId, edit: vi.fn(async () => undefined) }
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
      now: new Date("2026-04-24T12:00:00.000Z"),
      seed: { sessions: [session], members: seededMembers }
    });
    const interaction = buildButtonInteraction(`postpone:${session.id}:ok`);
    const interactionWithMessage = {
      ...interaction,
      message: { id: session.postponeMessageId, edit: vi.fn(async () => undefined) }
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
    const now = new Date("2026-04-24T12:00:00.000Z");
    const context = createTestAppContext({
      now,
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
      message: { id: session.postponeMessageId, edit: vi.fn(async () => undefined) }
    };

    await handlePostponeButton(
      asButtonInteraction(interactionWithMessage),
      buildDeps(context, client)
    );

    const sessions = context.ports.sessions.listSessions();
    const persisted = sessions.find((row) => row.id === session.id);
    const saturday = sessions.find((row) => row.weekKey === session.weekKey && row.postponeCount === 1);
    expect({
      status: persisted?.status,
      cancelReason: persisted?.cancelReason,
      updatedAt: persisted?.updatedAt
    }).toStrictEqual({
      status: "POSTPONED",
      cancelReason: null,
      updatedAt: now
    });
    expect({
      weekKey: saturday?.weekKey,
      postponeCount: saturday?.postponeCount,
      candidateDateIso: saturday?.candidateDateIso,
      status: saturday?.status,
      askMessageId: saturday?.askMessageId,
      deadlineAt: saturday?.deadlineAt
    }).toStrictEqual({
      weekKey: session.weekKey,
      postponeCount: 1,
      candidateDateIso: "2026-04-25",
      status: "ASKING",
      askMessageId: null,
      deadlineAt: new Date("2026-04-25T12:30:00.000Z")
    });
    expect(channelSend).not.toHaveBeenCalled();
    expect(context.ports.outbox.listEntries().map((entry) => ({
      sessionId: entry.sessionId,
      renderer: entry.payload.kind === "send_message" ? entry.payload.renderer : undefined,
      status: entry.status
    }))).toStrictEqual([{
      sessionId: saturday?.id,
      renderer: "ask_body",
      status: "PENDING"
    }]);
  });
});
