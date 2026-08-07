import { vi } from "vitest";

import type { ResponseRow, SessionRow } from "../../../src/db/rows.js";
import { appConfig } from "../../../src/userConfig.js";
import {
  createDiscordTextFixture,
  createEditableMessage
} from "../../helpers/discord.js";
import { buildSessionRow } from "../factories/session.js";

export interface MessagePayload {
  readonly content?: string;
  readonly components?: ReadonlyArray<{ readonly toJSON: () => unknown }>;
}

export const sessionRow = (overrides: Partial<SessionRow> = {}): SessionRow =>
  buildSessionRow({
    id: "session-1",
    askMessageId: "ask-msg-1",
    postponeMessageId: "postpone-msg-1",
    ...overrides
  });

export const seededMembers = appConfig.memberUserIds.map((userId, index) => ({
  id: `member-${index + 1}`,
  userId,
  displayName: `Member ${index + 1}`
}));

export const postponeResponses = (
  choices: readonly ("POSTPONE_OK" | "POSTPONE_NG")[]
): ResponseRow[] =>
  choices.map((choice, index) => ({
    id: `response-${index + 1}`,
    sessionId: "session-1",
    memberId: seededMembers[index]!.id,
    choice,
    answeredAt: new Date(`2026-04-24T11:${String(index).padStart(2, "0")}:00.000Z`),
    sourceInteractionId: null
  }));

export const createSettleDiscordFixture = () => {
  const sentPayloads: unknown[] = [];
  const fetchedMessage = createEditableMessage("fetched-message-1");
  const fixture = createDiscordTextFixture(
    async (payload) => {
      sentPayloads.push(payload);
      return { id: `posted-${sentPayloads.length}` };
    },
    { fetchedMessage }
  );

  return {
    ...fixture,
    edit: vi.mocked(fetchedMessage.edit),
    sentPayloads
  };
};

export const asMessagePayload = (value: unknown): MessagePayload =>
  value as MessagePayload;

export const renderedComponentData = (payload: MessagePayload): readonly unknown[] =>
  payload.components?.map((component) => component.toJSON()) ?? [];
