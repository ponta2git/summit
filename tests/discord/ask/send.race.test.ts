import { ChannelType, type Client } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { __resetSendStateForTest, sendAskMessage } from "../../../src/discord/ask/send.js";
import type { DbLike, SessionRow } from "../../../src/db/repositories/sessions.js";
import { __resetShutdownStateForTest } from "../../../src/shutdown.js";
import { deferred } from "../../helpers/deferred.js";
import { memberUserId } from "../../helpers/env.js";

const createMockClient = (channel: unknown): Client =>
  ({
    channels: {
      fetch: vi.fn(async () => channel)
    }
  }) as unknown as Client;

/**
 * Build an in-memory DbLike mock for sendAskMessage.
 * Mimics uniqueness on (weekKey, postponeCount) for ASKING sessions.
 */
const createMockDb = () => {
  const sessions: SessionRow[] = [];
  const selectBuilder = () => ({
    from: () => ({
      where: () => ({
        limit: async () => sessions
      })
    })
  });
  const insertBuilder = () => ({
    values: (row: Partial<SessionRow>) => ({
      onConflictDoNothing: () => ({
        returning: async () => {
          const conflict = sessions.some(
            (s) => s.weekKey === row.weekKey && s.postponeCount === row.postponeCount
          );
          if (conflict) {
            return [];
          }
          const full: SessionRow = {
            id: row.id ?? "",
            weekKey: row.weekKey ?? "",
            postponeCount: row.postponeCount ?? 0,
            candidateDate: row.candidateDate ?? "",
            status: row.status ?? "ASKING",
            channelId: row.channelId ?? "",
            askMessageId: null,
            postponeMessageId: null,
            deadlineAt: row.deadlineAt ?? new Date(0),
            decidedStartAt: null,
            cancelReason: null,
            reminderAt: null,
            reminderSentAt: null,
            createdAt: new Date(0),
            updatedAt: new Date(0)
          };
          sessions.push(full);
          return [full];
        }
      })
    })
  });
  const updateBuilder = () => ({
    set: () => ({
      where: async () => undefined
    })
  });
  const mock = {
    __sessions: sessions,
    select: vi.fn(selectBuilder),
    insert: vi.fn(insertBuilder),
    update: vi.fn(updateBuilder)
  };
  return mock as unknown as DbLike & { __sessions: SessionRow[] };
};

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
    const clock = { now: () => new Date("2026-04-24T18:00:00+09:00") };
    const db = createMockDb();

    const first = sendAskMessage(client, { trigger: "cron", clock, db });
    const second = sendAskMessage(client, {
      trigger: "command",
      invokerId: memberUserId,
      clock,
      db
    });

    await sendCalled.promise;
    sendDone.resolve({ id: "race-message" });

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.status).toBe("sent");
    expect(secondResult.status).toBe("skipped");
    expect(send).toHaveBeenCalledTimes(1);
  });
});
