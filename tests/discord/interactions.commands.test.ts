import { MessageFlags, type Interaction } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import {
  handleInteraction,
  registerInteractionHandlers
} from "../../src/discord/shared/dispatcher.js";
import { askMessages } from "../../src/features/ask-session/messages.js";
import { cancelWeekMessages } from "../../src/features/cancel-week/messages.js";
import { rejectMessages } from "../../src/features/interaction-reject/messages.js";
import { logger } from "../../src/logger.js";
import { callArg } from "../helpers/assertions.js";
import { asDiscordClient } from "../helpers/discord.js";
import { memberUserId } from "../helpers/env.js";
import {
  asInteraction,
  buildAskInteraction,
  buildCancelInteraction
} from "../helpers/interaction.js";
import { createTestAppContext } from "../testing/index.js";
import {
  defaultInteractionDeps,
  successfulSendAsk
} from "./interactions.harness.js";

describe("interaction command routing", () => {
  it("handles /ask success", async () => {
    const sendAsk = successfulSendAsk();
    const interaction = buildAskInteraction();

    await handleInteraction(asInteraction(interaction), defaultInteractionDeps(sendAsk));

    expect(interaction.deferReply).toHaveBeenCalledOnce();
    expect(interaction.editReply).toHaveBeenCalledOnce();
    expect(interaction.editReply).toHaveBeenCalledWith(askMessages.interaction.ask.queued);
    expect(sendAsk).toHaveBeenCalledOnce();
    expect(sendAsk).toHaveBeenCalledWith({ trigger: "command", invokerId: memberUserId });
  });

  it("rejects /ask from a non-member without sending", async () => {
    const sendAsk = successfulSendAsk();
    const interaction = buildAskInteraction({ user: { id: "999999999999999999" } });

    await handleInteraction(asInteraction(interaction), defaultInteractionDeps(sendAsk));

    expect(interaction.deferReply).toHaveBeenCalledOnce();
    expect(interaction.editReply).toHaveBeenCalledWith(rejectMessages.reject.notMember);
    expect(sendAsk).not.toHaveBeenCalled();
  });

  it.each(["throw", "reject"])("returns a failure response when /ask sending fails by %s", async mode => {
    const sendAsk = vi.fn(() => {
      const error = new Error("discord api failed");
      if (mode === "throw") { throw error; }
      return Promise.reject(error);
    });
    const interaction = buildAskInteraction();

    await handleInteraction(asInteraction(interaction), defaultInteractionDeps(sendAsk));

    expect(interaction.deferReply).toHaveBeenCalledOnce();
    expect(interaction.editReply).toHaveBeenCalledWith(askMessages.interaction.ask.failed);
  });

  it("opens the /cancel_week confirmation dialog", async () => {
    const interaction = buildCancelInteraction();

    await handleInteraction(
      asInteraction(interaction),
      defaultInteractionDeps(successfulSendAsk())
    );

    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    const payload = callArg<{ content: string; components: readonly unknown[] }>(
      interaction.editReply
    );
    expect({ content: payload.content, componentRows: payload.components.length }).toStrictEqual({
      content: cancelWeekMessages.cancelWeek.confirmPrompt,
      componentRows: 1
    });
  });

  it("rejects /cancel_week from a non-member", async () => {
    const interaction = buildCancelInteraction({ user: { id: "999999999999999999" } });

    await handleInteraction(
      asInteraction(interaction),
      defaultInteractionDeps(successfulSendAsk())
    );

    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(interaction.editReply).toHaveBeenCalledWith(rejectMessages.reject.notMember);
  });
});

describe("interaction event listener", () => {
  it("logs and replies when dispatch crashes", async () => {
    const on = vi.fn();
    const client = asDiscordClient({ on });
    const loggerErrorSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    registerInteractionHandlers(client, createTestAppContext({
      now: new Date("2026-04-24T10:00:00.000Z")
    }));
    const listener = callArg<(interaction: Interaction) => void>(on, 0, 1);
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
});
