import { MessageFlags } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import { handleInteraction } from "../../src/discord/shared/dispatcher.js";
import { askMessages } from "../../src/features/ask-session/messages.js";
import { rejectMessages } from "../../src/features/interaction-reject/messages.js";
import { postponeMessages } from "../../src/features/postpone-voting/messages.js";
import { logger } from "../../src/logger.js";
import { callArg } from "../helpers/assertions.js";
import { memberUserId } from "../helpers/env.js";
import {
  asInteraction,
  buildButtonInteraction
} from "../helpers/interaction.js";
import { buildSessionRow } from "../testing/sessionScenario.ts";
import {
  createMemberSeededContext,
  defaultInteractionDeps,
  successfulSendAsk
} from "./interactions.harness.js";

const SESSION_ID = "4f7d54aa-3898-4a13-9f7c-5872a8220e0f";

describe("interaction button routing", () => {
  it("rejects an invalid ask custom id", async () => {
    const interaction = buildButtonInteraction("ask:not-a-uuid:t2200");

    await handleInteraction(
      asInteraction(interaction),
      defaultInteractionDeps(successfulSendAsk())
    );

    expect(interaction.deferUpdate).toHaveBeenCalledOnce();
    expect(interaction.followUp).toHaveBeenCalledWith({
      content: rejectMessages.reject.invalidCustomId,
      flags: MessageFlags.Ephemeral
    });
  });

  it("records a postpone OK vote and updates the public message", async () => {
    const session = buildSessionRow({
      id: SESSION_ID,
      status: "POSTPONE_VOTING",
      postponeMessageId: "postpone-msg-1",
      deadlineAt: new Date("2026-04-24T15:00:00.000Z")
    });
    const ctx = createMemberSeededContext(session, new Date("2026-04-24T12:00:00.000Z"));
    const baseInteraction = buildButtonInteraction(`postpone:${SESSION_ID}:ok`);
    const interaction = {
      ...baseInteraction,
      message: { id: session.postponeMessageId, edit: vi.fn(async () => undefined) }
    };

    await handleInteraction(
      asInteraction(interaction),
      defaultInteractionDeps(successfulSendAsk(), ctx)
    );

    expect(interaction.deferUpdate).toHaveBeenCalledOnce();
    expect(interaction.followUp).not.toHaveBeenCalled();
    expect(interaction.message.edit).toHaveBeenCalledOnce();
    expect(
      (await ctx.ports.responses.listResponses(SESSION_ID)).map((response) => ({
        sessionId: response.sessionId,
        memberId: response.memberId,
        choice: response.choice
      }))
    ).toStrictEqual([{
      sessionId: SESSION_ID,
      memberId: "member-0",
      choice: "POSTPONE_OK"
    }]);
  });

  it("reports an unknown or stale button and records structured context", async () => {
    const sendAsk = successfulSendAsk();
    const loggerWarnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const interaction = buildButtonInteraction("totally:unknown:id");

    await handleInteraction(asInteraction(interaction), defaultInteractionDeps(sendAsk));

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
      interactionId: "323456789012345679",
      userId: memberUserId,
      customId: "totally:unknown:id",
      reason: "unknown_or_stale_button",
      message: "Unknown or stale button custom_id."
    });
    expect(sendAsk).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "wrong channel",
      override: { channelId: "000000000000000000" },
      expected: rejectMessages.reject.wrongChannel
    },
    {
      label: "non-member",
      override: { user: { id: "999999999999999999" } },
      expected: rejectMessages.reject.notMember
    },
    {
      label: "wrong guild",
      override: { guildId: "000000000000000000" },
      expected: rejectMessages.reject.wrongGuild
    }
  ])("rejects a button from the $label", async ({ override, expected }) => {
    const sendAsk = successfulSendAsk();
    const interaction = buildButtonInteraction(`ask:${SESSION_ID}:t2200`, override);

    await handleInteraction(asInteraction(interaction), defaultInteractionDeps(sendAsk));

    expect(interaction.deferUpdate).toHaveBeenCalledOnce();
    expect(interaction.followUp).toHaveBeenCalledWith({
      content: expected,
      flags: MessageFlags.Ephemeral
    });
    expect(sendAsk).not.toHaveBeenCalled();
  });

  it("records an ask vote and updates the public message", async () => {
    const session = buildSessionRow({ id: SESSION_ID, askMessageId: "test-msg-id" });
    const ctx = createMemberSeededContext(session, new Date("2026-04-24T10:00:00.000Z"));
    const baseInteraction = buildButtonInteraction(`ask:${SESSION_ID}:t2200`);
    const interaction = {
      ...baseInteraction,
      message: { id: session.askMessageId, edit: vi.fn(async () => undefined) }
    };

    await handleInteraction(
      asInteraction(interaction),
      defaultInteractionDeps(successfulSendAsk(), ctx)
    );

    expect(
      (await ctx.ports.responses.listResponses(SESSION_ID)).map((response) => ({
        sessionId: response.sessionId,
        memberId: response.memberId,
        choice: response.choice
      }))
    ).toStrictEqual([{ sessionId: SESSION_ID, memberId: "member-0", choice: "T2200" }]);
    expect(interaction.message.edit).toHaveBeenCalledOnce();
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  it("asks for absent confirmation without recording a response", async () => {
    const session = buildSessionRow({ id: SESSION_ID, askMessageId: "test-msg-id" });
    const ctx = createMemberSeededContext(session, new Date("2026-04-24T10:00:00.000Z"));
    const interaction = buildButtonInteraction(`ask:${SESSION_ID}:absent`);

    await handleInteraction(
      asInteraction(interaction),
      defaultInteractionDeps(successfulSendAsk(), ctx)
    );

    expect(await ctx.ports.responses.listResponses(SESSION_ID)).toStrictEqual([]);
    expect(interaction.deferUpdate).toHaveBeenCalledOnce();
    const payload = callArg<{ content: string; components: readonly unknown[]; flags: unknown }>(
      interaction.followUp
    );
    expect({ content: payload.content, componentRows: payload.components.length, flags: payload.flags })
      .toStrictEqual({
        content: askMessages.absentConfirm.prompt,
        componentRows: 1,
        flags: MessageFlags.Ephemeral
      });
  });

  it("asks for postpone NG confirmation without recording a response", async () => {
    const session = buildSessionRow({
      id: SESSION_ID,
      status: "POSTPONE_VOTING",
      postponeMessageId: "postpone-msg-1",
      deadlineAt: new Date("2026-04-24T15:00:00.000Z")
    });
    const ctx = createMemberSeededContext(session, new Date("2026-04-24T12:00:00.000Z"));
    const interaction = buildButtonInteraction(`postpone:${SESSION_ID}:ng`);

    await handleInteraction(
      asInteraction(interaction),
      defaultInteractionDeps(successfulSendAsk(), ctx)
    );

    expect(await ctx.ports.responses.listResponses(SESSION_ID)).toStrictEqual([]);
    expect(interaction.deferUpdate).toHaveBeenCalledOnce();
    const payload = callArg<{ content: string; components: readonly unknown[]; flags: unknown }>(
      interaction.followUp
    );
    expect({ content: payload.content, componentRows: payload.components.length, flags: payload.flags })
      .toStrictEqual({
        content: postponeMessages.ngConfirm.prompt,
        componentRows: 1,
        flags: MessageFlags.Ephemeral
      });
  });
});
