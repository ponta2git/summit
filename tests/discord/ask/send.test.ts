import { ChannelType, type Client } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetSendStateForTest,
  sendAskMessage,
  sendPostponedAskMessage
} from "../../../src/discord/ask/send.js";
import { __resetShutdownStateForTest } from "../../../src/shutdown.js";
import { deferred } from "../../helpers/deferred.js";
import { createTestAppContext, makeSession } from "../../testing/index.js";
import { buildSessionRow } from "../factories/session.js";

const seedMembers = [
  { id: "member-1", userId: "323456789012345678", displayName: "いーゆー" },
  { id: "member-2", userId: "423456789012345678", displayName: "おーたか" },
  { id: "member-3", userId: "523456789012345678", displayName: "あかねまみ" },
  { id: "member-4", userId: "623456789012345678", displayName: "ぽんた" }
];

const saturdaySession = makeSession({
  id: "sat-session-1",
  weekKey: "2026-W17",
  postponeCount: 1,
  candidateDateIso: "2026-04-25",
  status: "ASKING",
  askMessageId: null
});

const createMockClient = (channel: unknown): Client =>
  ({
    channels: {
      fetch: vi.fn(async () => channel)
    }
  }) as unknown as Client;

const buildSendableChannel = (send: ReturnType<typeof vi.fn>) => ({
  type: ChannelType.GuildText,
  isSendable: () => true,
  send
});

describe("sendPostponedAskMessage", () => {
  beforeEach(() => {
    __resetSendStateForTest();
    __resetShutdownStateForTest();
  });

  it("sends the Discord message and saves ask_message_id", async () => {
    const send = vi.fn(async () => ({ id: "sat-discord-msg-1" }));
    const channel = buildSendableChannel(send);
    const client = createMockClient(channel);

    const ctx = createTestAppContext({
      seed: { members: seedMembers, sessions: [saturdaySession] }
    });

    await sendPostponedAskMessage(client, ctx, saturdaySession);

    expect(send).toHaveBeenCalledTimes(1);

    const calls = ctx.ports.sessions.calls.filter((c) => c.name === "updateAskMessageId");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toMatchObject({ id: "sat-session-1", messageId: "sat-discord-msg-1" });
  });

  it("skips sending when ask_message_id is already set (reentrant / restart)", async () => {
    const alreadySent = makeSession({
      ...saturdaySession,
      askMessageId: "already-set-msg-id"
    });
    const send = vi.fn();
    const channel = buildSendableChannel(send);
    const client = createMockClient(channel);

    const ctx = createTestAppContext({
      seed: { members: seedMembers, sessions: [alreadySent] }
    });

    await sendPostponedAskMessage(client, ctx, alreadySent);

    // idempotent: channel.send を呼ばず、updateAskMessageId も呼ばない。
    expect(send).not.toHaveBeenCalled();
    const updateCalls = ctx.ports.sessions.calls.filter((c) => c.name === "updateAskMessageId");
    expect(updateCalls).toHaveLength(0);
  });

  it("surfaces Discord send error and does not save ask_message_id", async () => {
    const discordError = new Error("Discord API error");
    const send = vi.fn(async () => { throw discordError; });
    const channel = buildSendableChannel(send);
    const client = createMockClient(channel);

    const ctx = createTestAppContext({
      seed: { members: seedMembers, sessions: [saturdaySession] }
    });

    await expect(sendPostponedAskMessage(client, ctx, saturdaySession)).rejects.toThrow(
      "Discord API error"
    );

    const updateCalls = ctx.ports.sessions.calls.filter((c) => c.name === "updateAskMessageId");
    expect(updateCalls).toHaveLength(0);
  });

  it("throws when called with postponeCount !== 1", async () => {
    const fridaySession = buildSessionRow({ postponeCount: 0 });
    const client = createMockClient(null);
    const ctx = createTestAppContext({ seed: { members: seedMembers } });

    await expect(sendPostponedAskMessage(client, ctx, fridaySession)).rejects.toThrow(
      "expected postponeCount=1"
    );
  });

  describe("in-flight dedup", () => {
    it("serializes concurrent Saturday sends and avoids duplicate posts", async () => {
      // race: 並走する土曜送信を 1 本化する。
      const sendCalled = deferred<void>();
      const sendDone = deferred<{ id: string }>();
      const send = vi.fn(async () => {
        sendCalled.resolve();
        return sendDone.promise;
      });
      const channel = buildSendableChannel(send);
      const client = createMockClient(channel);

      const ctx = createTestAppContext({
        seed: { members: seedMembers, sessions: [saturdaySession] }
      });

      const first = sendPostponedAskMessage(client, ctx, saturdaySession);
      // second starts before first completes — the in-flight map should serialize it
      const second = sendPostponedAskMessage(client, ctx, saturdaySession);

      await sendCalled.promise;
      sendDone.resolve({ id: "sat-msg-dedup" });

      await Promise.all([first, second]);

      expect(send).toHaveBeenCalledTimes(1);
    });

    it("Friday (postponeCount=0) and Saturday (postponeCount=1) sends with same weekKey proceed independently", async () => {
      // race: 旧実装では weekKey のみをキーにしていたため、Friday の in-flight が Saturday をブロックした。
      //   ${weekKey}:0 と ${weekKey}:1 に分離したことで、両者は互いをブロックせず並走できる。
      const fridaySendCalled = deferred<void>();
      const fridaySendDone = deferred<{ id: string }>();
      const saturdaySendCalled = deferred<void>();
      const saturdaySendDone = deferred<{ id: string }>();

      let sendInvocation = 0;
      const send = vi.fn(async () => {
        const n = ++sendInvocation;
        if (n === 1) {
          // Friday reaches channel.send first; hold it open
          fridaySendCalled.resolve();
          return fridaySendDone.promise;
        }
        // Saturday reaches channel.send while Friday is still pending
        saturdaySendCalled.resolve();
        return saturdaySendDone.promise;
      });

      const channel = buildSendableChannel(send);
      const client = createMockClient(channel);

      const ctx = createTestAppContext({
        now: new Date("2026-04-24T18:00:00+09:00"),
        seed: { members: seedMembers, sessions: [saturdaySession] }
      });

      // Start Friday send (will block at channel.send)
      const fridayPromise = sendAskMessage(client, { trigger: "cron", context: ctx });

      // Wait for Friday to reach channel.send
      await fridaySendCalled.promise;

      // Start Saturday send while Friday is still in-flight.
      // With ${weekKey}:1 key, it must NOT be blocked by Friday's ${weekKey}:0 entry.
      const saturdayPromise = sendPostponedAskMessage(client, ctx, saturdaySession);

      // Saturday must reach channel.send before Friday resolves
      await saturdaySendCalled.promise;

      // Resolve both
      fridaySendDone.resolve({ id: "fri-msg" });
      saturdaySendDone.resolve({ id: "sat-msg" });

      const fridayResult = await fridayPromise;
      await saturdayPromise;

      expect(fridayResult.status).toBe("sent");
      expect(send).toHaveBeenCalledTimes(2);
    });
  });
});
