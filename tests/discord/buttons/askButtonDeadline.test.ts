import { MessageFlags } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import { handleInteraction } from "../../../src/discord/shared/dispatcher.ts";
import type { InteractionHandlerDeps } from "../../../src/discord/shared/dispatcher.js";
import { appConfig } from "../../../src/userConfig.js";
import { rejectMessages } from "../../../src/features/interaction-reject/messages.js";
import { asInteraction, buildButtonInteraction } from "../../helpers/interaction.js";
import { asDiscordClient } from "../../helpers/discord.js";
import { buildSessionRow } from "../../testing/sessionScenario.ts";
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
  client: asDiscordClient({}),
  sendAsk: vi.fn(async () => ({ status: "queued" as const, weekKey: "2026-W17" }))
});

describe("handleAskButton deadline guard", () => {
  it("keeps the session ASKING when the fourth time response arrives before the deadline", async () => {
    const session = buildSessionRow({
      id: "4f7d54aa-3898-4a13-9f7c-5872a8220e0f",
      status: "ASKING",
      askMessageId: "ask-msg-1",
      deadlineAt: new Date("2026-04-24T12:30:00.000Z")
    });
    const context = createTestAppContext({
      now: new Date("2026-04-24T12:29:00.000Z"),
      seed: {
        sessions: [session],
        members: seededMembers,
        responses: [
          {
            id: "response-1",
            sessionId: session.id,
            memberId: "member-1",
            choice: "T2230",
            answeredAt: new Date("2026-04-24T12:20:00.000Z"),
            sourceInteractionId: null
          },
          {
            id: "response-2",
            sessionId: session.id,
            memberId: "member-2",
            choice: "T2300",
            answeredAt: new Date("2026-04-24T12:21:00.000Z"),
            sourceInteractionId: null
          },
          {
            id: "response-3",
            sessionId: session.id,
            memberId: "member-3",
            choice: "T2330",
            answeredAt: new Date("2026-04-24T12:22:00.000Z"),
            sourceInteractionId: null
          }
        ]
      }
    });
    const interaction = {
      ...buildButtonInteraction(`ask:${session.id}:t2200`),
      message: { id: session.askMessageId, edit: vi.fn(async () => undefined) }
    };

    await handleInteraction(asInteraction(interaction), buildDeps(context));

    expect((await context.ports.sessions.findSessionById(session.id))?.status).toBe("ASKING");
    expect(await context.ports.responses.listResponses(session.id)).toHaveLength(4);
    expect(context.ports.outbox.listEntries()).toStrictEqual([]);
    expect(interaction.message.edit).toHaveBeenCalledOnce();
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
      message: { id: session.askMessageId, edit: vi.fn(async () => undefined) }
    };

    await handleInteraction(
      asInteraction(interaction),
      buildDeps(context)
    );

    expect(await context.ports.responses.listResponses(session.id)).toHaveLength(0);
    expect(interaction.followUp).toHaveBeenCalledWith({
      content: rejectMessages.reject.askingClosed,
      flags: MessageFlags.Ephemeral
    });
  });
});
