import type { Client, Interaction } from "discord.js";
import { MessageFlags } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import { handleInteraction, type AppReadyState } from "../../src/discord/shared/dispatcher.js";
import { appConfig } from "../../src/userConfig.js";
import { logger } from "../../src/logger.js";
import { callArg } from "../helpers/assertions.js";
import { buildButtonInteraction, buildAskInteraction } from "../helpers/interaction.js";
import { buildSessionRow } from "./factories/session.js";
import { createTestAppContext, type TestAppContext } from "../testing/index.js";

const bootMessage = "起動処理中です。数秒待って再度お試しください。";

const stubClient = {} as Client;

const buildDeps = (context: TestAppContext, readyState: AppReadyState) => ({
  context,
  client: stubClient,
  getReadyState: () => readyState,
  sendAsk: vi.fn(async () => ({ status: "sent" as const, weekKey: "2026-W17" }))
}) as Parameters<typeof handleInteraction>[1];

describe("startup interaction ready gate", () => {
  it("rejects ask button while app is not ready and does not touch DB", async () => {
    const session = buildSessionRow({
      id: "4f7d54aa-3898-4a13-9f7c-5872a8220e0f",
      askMessageId: "ask-msg-1"
    });
    const context = createTestAppContext({
      seed: {
        sessions: [session],
        members: [
          { id: "member-0", userId: appConfig.memberUserIds[0]!, displayName: "Member 0" }
        ]
      }
    });
    const interaction = {
      ...buildButtonInteraction(`ask:${session.id}:t2200`),
      message: { edit: vi.fn(async () => undefined) }
    };
    const loggerInfoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined);

    await handleInteraction(
      interaction as unknown as Interaction,
      buildDeps(context, { ready: false, reason: "startup" })
    );

    expect(interaction.deferUpdate).toHaveBeenCalledOnce();
    expect(interaction.followUp).toHaveBeenCalledWith({
      content: bootMessage,
      flags: MessageFlags.Ephemeral
    });
    expect(
      context.ports.responses.calls.some((call) => call.name === "upsertResponse")
    ).toBe(false);
    const [fields, message] = [
      callArg<Record<string, unknown>>(loggerInfoSpy),
      callArg<string>(loggerInfoSpy, 0, 1)
    ];
    expect({
      event: fields["event"],
      interactionId: fields["interactionId"],
      userId: fields["userId"],
      customId: fields["customId"],
      reason: fields["reason"],
      message
    }).toStrictEqual({
      event: "interaction.rejected_not_ready",
      interactionId: "interaction-button",
      userId: interaction.user.id,
      customId: interaction.customId,
      reason: "startup",
      message: "Rejected interaction because startup/reconnect is not ready."
    });
  });

  it("rejects slash command while app is not ready", async () => {
    const context = createTestAppContext();
    const interaction = buildAskInteraction();

    await handleInteraction(
      interaction as unknown as Interaction,
      buildDeps(context, { ready: false, reason: "startup" })
    );

    expect(interaction.reply).toHaveBeenCalledWith({
      content: bootMessage,
      flags: MessageFlags.Ephemeral
    });
    expect(interaction.deferReply).not.toHaveBeenCalled();
  });
});
