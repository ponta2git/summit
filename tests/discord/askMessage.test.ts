import { ChannelType, type Client } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetSendStateForTest,
  buildAskRow,
  renderAskBody,
  sendAskMessage
} from "../../src/discord/askMessage.js";
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

describe("askMessage", () => {
  beforeEach(() => {
    __resetSendStateForTest();
    __resetShutdownStateForTest();
  });

  it("builds ask buttons with expected custom ids", () => {
    const row = buildAskRow("session-id");
    const customIds = row
      .toJSON()
      .components.map((component) => ("custom_id" in component ? component.custom_id : undefined));

    expect(customIds).toEqual([
      "ask:session-id:t2200",
      "ask:session-id:t2230",
      "ask:session-id:t2300",
      "ask:session-id:t2330",
      "ask:session-id:absent"
    ]);
  });

  it("renders ask message body with mentions and candidate date", () => {
    const rendered = renderAskBody("session-id", new Date("2026-04-24T22:00:00+09:00"));

    for (const memberId of env.MEMBER_USER_IDS) {
      expect(rendered.content).toContain(`<@${memberId}>`);
    }
    expect(rendered.content).toContain("開催候補日: 2026-04-24(金) 22:00 以降");
    expect(rendered.components).toHaveLength(1);
  });

  it("sends once per week and then skips duplicates", async () => {
    const send = vi.fn(async () => ({ id: "message-1" }));
    const channel = {
      type: ChannelType.GuildText,
      isSendable: () => true,
      send
    };
    const client = createMockClient(channel);
    const fixedClock = { now: () => new Date("2026-04-24T18:00:00+09:00") };

    const first = await sendAskMessage(client, {
      trigger: "command",
      invokerId: memberUserId,
      clock: fixedClock
    });
    const second = await sendAskMessage(client, {
      trigger: "command",
      invokerId: memberUserId,
      clock: fixedClock
    });

    expect(first.status).toBe("sent");
    expect(second.status).toBe("skipped");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("throws when configured channel is not sendable", async () => {
    const client = createMockClient(null);

    await expect(
      sendAskMessage(client, {
        trigger: "command",
        invokerId: memberUserId,
        clock: { now: () => new Date("2026-04-25T23:30:00+09:00") }
      })
    ).rejects.toThrow("Configured channel is not sendable.");
  });
});
