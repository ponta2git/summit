import { vi } from "vitest";

import type {
  InteractionHandlerDeps,
  SendAsk
} from "../../src/discord/shared/dispatcher.js";
import type { SessionRow } from "../../src/db/rows.js";
import { appConfig } from "../../src/userConfig.js";
import { asDiscordClient } from "../helpers/discord.js";
import { createTestAppContext, type TestAppContext } from "../testing/index.js";

const DEFAULT_NOW = new Date("2026-04-24T10:00:00.000Z");
const stubClient = asDiscordClient({});

export const successfulSendAsk = () =>
  vi.fn(async () => ({ status: "sent" as const, weekKey: "2026-W17" }));

export const defaultInteractionDeps = (
  sendAsk: ReturnType<typeof vi.fn>,
  context: TestAppContext = createTestAppContext({ now: DEFAULT_NOW })
): InteractionHandlerDeps => ({
  sendAsk: sendAsk as SendAsk,
  client: stubClient,
  context
});

export const createMemberSeededContext = (
  session: SessionRow,
  now: Date
): TestAppContext =>
  createTestAppContext({
    now,
    seed: {
      sessions: [session],
      members: appConfig.memberUserIds.map((userId, index) => ({
        id: `member-${index}`,
        userId,
        displayName: `Member ${index}`
      }))
    }
  });
