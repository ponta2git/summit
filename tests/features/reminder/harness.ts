import type { SessionRow } from "../../../src/db/rows.js";
import { createDiscordTextFixture } from "../../helpers/discord.js";
import { buildSessionRow } from "../../testing/sessionScenario.ts";
import { makeResponse } from "../../testing/fixtures.js";

export const TEST_NOW = new Date("2026-04-24T12:45:00.000Z");

export const decidedSession = (overrides: Partial<SessionRow> = {}): SessionRow => {
  const decidedStartAt = new Date("2026-04-24T13:00:00.000Z");
  return buildSessionRow({
    id: "session-reminder-1",
    askMessageId: "ask-msg-1",
    candidateDateIso: "2026-04-24",
    status: "DECIDED",
    decidedStartAt,
    reminderAt: new Date(decidedStartAt.getTime() - 15 * 60_000),
    reminderSentAt: null,
    ...overrides
  });
};

export const timeResponses = (sessionId: string): ReturnType<typeof makeResponse>[] => [
  makeResponse({ id: "r1", sessionId, memberId: "member-1", choice: "T2200" }),
  makeResponse({ id: "r2", sessionId, memberId: "member-2", choice: "T2230" }),
  makeResponse({ id: "r3", sessionId, memberId: "member-3", choice: "T2200" }),
  makeResponse({ id: "r4", sessionId, memberId: "member-4", choice: "T2300" })
];

export const createReminderDiscord = (
  options: { readonly sendFails?: boolean } = {}
) => createDiscordTextFixture(async () => {
  if (options.sendFails === true) {
    throw new Error("send failed");
  }
  return { id: "reminder-msg-id" };
});
