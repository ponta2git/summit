import { ChannelType, type Client } from "discord.js";
import { vi } from "vitest";

import type { ResponseRow, SessionRow } from "../../../src/db/rows.js";
import type { InteractionHandlerDeps } from "../../../src/discord/shared/dispatcher.js";
import { appConfig } from "../../../src/userConfig.js";
import { asDiscordClient } from "../../helpers/discord.js";
import type { createTestAppContext } from "../../testing/index.js";
import { buildSessionRow } from "../../testing/sessionScenario.ts";

export const seededMembers = appConfig.memberUserIds.map((userId, index) => ({
  id: `member-${index}`,
  userId,
  displayName: `Member ${index + 1}`
}));

export const postponeSession = (
  overrides: Partial<SessionRow> = {}
): SessionRow =>
  buildSessionRow({
    id: "4f7d54aa-3898-4a13-9f7c-5872a8220e0f",
    status: "POSTPONE_VOTING",
    postponeCount: 0,
    postponeMessageId: "postpone-msg-1",
    deadlineAt: new Date("2026-04-24T15:00:00.000Z"),
    ...overrides
  });

export const postponeResponse = (
  index: number,
  choice: "POSTPONE_OK" | "POSTPONE_NG",
  sessionId: string
): ResponseRow => ({
  id: `response-${index}`,
  sessionId,
  memberId: seededMembers[index]!.id,
  choice,
  answeredAt: new Date(`2026-04-24T12:${String(index).padStart(2, "0")}:00.000Z`),
  sourceInteractionId: null
});

export const createDiscordClient = () => {
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
    channels: { fetch: vi.fn(async () => channel) }
  });
  return { client, postponeMessageEdit, channelSend };
};

export const buildDeps = (
  context: ReturnType<typeof createTestAppContext>,
  client: Client
): InteractionHandlerDeps => ({
  context,
  client,
  sendAsk: vi.fn(async () => ({ status: "queued" as const, weekKey: "2026-W17" }))
});
