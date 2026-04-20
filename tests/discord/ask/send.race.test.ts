import { ChannelType, type Client } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { __resetSendStateForTest, sendAskMessage } from "../../../src/discord/ask/send.js";
import { __resetShutdownStateForTest } from "../../../src/shutdown.js";
import { deferred } from "../../helpers/deferred.js";
import { memberUserId } from "../../helpers/env.js";
import { createTestAppContext } from "../../testing/index.js";

const createMockClient = (channel: unknown): Client =>
  ({
    channels: {
      fetch: vi.fn(async () => channel)
    }
  }) as unknown as Client;

const seedMembers = [
  { id: "member-1", userId: "323456789012345678", displayName: "いーゆー" },
  { id: "member-2", userId: "423456789012345678", displayName: "おーたか" },
  { id: "member-3", userId: "523456789012345678", displayName: "あかねまみ" },
  { id: "member-4", userId: "623456789012345678", displayName: "ぽんた" }
];

describe("askMessage race handling", () => {
  beforeEach(() => {
    __resetSendStateForTest();
    __resetShutdownStateForTest();
  });

  it("serializes concurrent sends and avoids duplicate posts", async () => {
    // race: 並走 send 呼び出しに対し、「first が channel.send に到達した瞬間」を明示的に awaitable にする。
    //   vi.waitFor の timeout 依存 (flake 源) を排除するため、mock 内で deferred を解決する。
    const sendCalled = deferred<void>();
    const sendDone = deferred<{ id: string }>();
    const send = vi.fn(() => {
      sendCalled.resolve();
      return sendDone.promise;
    });

    const channel = {
      type: ChannelType.GuildText,
      isSendable: () => true,
      send
    };
    const client = createMockClient(channel);
    const context = createTestAppContext({
      now: new Date("2026-04-24T18:00:00+09:00"),
      seed: { members: seedMembers }
    });

    const first = sendAskMessage(client, { trigger: "cron", context });
    const second = sendAskMessage(client, {
      trigger: "command",
      invokerId: memberUserId,
      context
    });

    await sendCalled.promise;
    sendDone.resolve({ id: "race-message" });

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.status).toBe("sent");
    expect(secondResult.status).toBe("skipped");
    expect(send).toHaveBeenCalledTimes(1);
  });
});
