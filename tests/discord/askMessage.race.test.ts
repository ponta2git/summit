import { ChannelType, type Client } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { __resetSendStateForTest, sendAskMessage } from "../../src/discord/askMessage.js";
import { env } from "../../src/env.js";
import { __resetShutdownStateForTest } from "../../src/shutdown.js";

const memberUserId = (() => {
  const userId = env.MEMBER_USER_IDS[0];
  if (!userId) {
    throw new Error("member user id is required for test setup");
  }
  return userId;
})();

const createMockClient = (channel: unknown): Client =>
  ({
    channels: {
      fetch: vi.fn(async () => channel)
    }
  }) as unknown as Client;

describe("askMessage race handling", () => {
  beforeEach(() => {
    __resetSendStateForTest();
    __resetShutdownStateForTest();
  });

  it("serializes concurrent sends and avoids duplicate posts", async () => {
    let resolveSend: ((value: { id: string }) => void) | undefined;
    const send = vi.fn(
      () =>
        new Promise<{ id: string }>((resolve) => {
          resolveSend = resolve;
        })
    );

    const channel = {
      type: ChannelType.GuildText,
      isSendable: () => true,
      send
    };
    const client = createMockClient(channel);
    const clock = { now: () => new Date("2026-04-24T18:00:00+09:00") };

    const first = sendAskMessage(client, {
      trigger: "cron",
      clock
    });
    const second = sendAskMessage(client, {
      trigger: "command",
      invokerId: memberUserId,
      clock
    });

    await Promise.resolve();
    resolveSend?.({ id: "race-message" });

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.status).toBe("sent");
    expect(secondResult.status).toBe("skipped");
    expect(send).toHaveBeenCalledTimes(1);
  });
});
