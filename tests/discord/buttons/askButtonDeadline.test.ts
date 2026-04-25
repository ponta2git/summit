import { MessageFlags, type Client } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleAskButton } from "../../../src/features/ask-session/button.js";
import type { InteractionHandlerDeps } from "../../../src/discord/shared/dispatcher.js";
import { appConfig } from "../../../src/userConfig.js";
import { rejectMessages } from "../../../src/features/interaction-reject/messages.js";
import { buildButtonInteraction } from "../../helpers/interaction.js";
import { buildSessionRow } from "../factories/session.js";
import { createTestAppContext } from "../../testing/index.js";

const seededMembers = appConfig.memberUserIds.map((userId, index) => ({
  id: `member-${index}`,
  userId,
  displayName: `Member ${index + 1}`
}));

const buildDeps = (
  context: ReturnType<typeof createTestAppContext>
): InteractionHandlerDeps => ({
  context,
  client: {} as Client,
  sendAsk: vi.fn(async () => ({ status: "sent" as const, weekKey: "2026-W17" }))
});

describe("handleAskButton deadline guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects responses after asking deadline and does not persist DB changes", async () => {
    const session = buildSessionRow({
      id: "4f7d54aa-3898-4a13-9f7c-5872a8220e0f",
      status: "ASKING",
      askMessageId: "ask-msg-1",
      deadlineAt: new Date("2026-04-24T12:00:00.000Z")
    });
    const context = createTestAppContext({
      now: new Date("2026-04-24T12:01:00.000Z"),
      seed: { sessions: [session], members: seededMembers }
    });
    const interaction = {
      ...buildButtonInteraction(`ask:${session.id}:t2200`),
      message: { edit: vi.fn(async () => undefined) }
    };

    await handleAskButton(
      interaction as unknown as Parameters<typeof handleAskButton>[0],
      buildDeps(context)
    );

    expect(await context.ports.responses.listResponses(session.id)).toHaveLength(0);
    expect(
      context.ports.responses.calls.some((call) => call.name === "upsertResponse")
    ).toBe(false);
    expect(interaction.followUp).toHaveBeenCalledWith({
      content: rejectMessages.reject.askingClosed,
      flags: MessageFlags.Ephemeral
    });
  });
});
