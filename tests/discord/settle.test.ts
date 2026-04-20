import { ChannelType, type Client } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionRow } from "../../src/db/types.js";
import { settleAskingSession } from "../../src/discord/settle.js";
import { createTestAppContext } from "../testing/index.js";

import { buildSessionRow } from "./factories/session.js";

const sessionRow = (overrides: Partial<SessionRow> = {}): SessionRow =>
  buildSessionRow({ id: "session-1", askMessageId: "ask-msg-1", ...overrides });

const stubChannel = () => {
  const sentMessages: { id: string }[] = [];
  const messageEdit = vi.fn();
  const channel = {
    type: ChannelType.GuildText,
    isSendable: () => true,
    send: vi.fn(async (_payload: unknown) => {
      const msg = { id: `posted-${sentMessages.length + 1}` };
      sentMessages.push(msg);
      return msg;
    }),
    messages: {
      fetch: vi.fn(async () => ({ edit: messageEdit }))
    }
  };
  return { channel, sentMessages, messageEdit };
};

const stubClient = (channel: unknown): Client =>
  ({
    channels: {
      fetch: vi.fn(async () => channel)
    }
  }) as unknown as Client;

describe("settleAskingSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("transitions ASKING → CANCELLED → POSTPONE_VOTING and posts both messages", async () => {
    const session = sessionRow();
    const ctx = createTestAppContext({ seed: { sessions: [session] } });
    // race: fake のデフォルト unique 制約では CAS 検証に影響しない。transitionStatus を実物で走らせる。
    const transitionSpy = vi.spyOn(ctx.ports.sessions, "transitionStatus");

    const { channel, sentMessages } = stubChannel();
    await settleAskingSession(stubClient(channel), ctx, session.id, "absent");

    expect(transitionSpy).toHaveBeenCalledTimes(2);
    const [firstCall, secondCall] = transitionSpy.mock.calls;
    expect(firstCall?.[0]).toMatchObject({
      from: "ASKING",
      to: "CANCELLED",
      cancelReason: "absent"
    });
    expect(secondCall?.[0]).toMatchObject({
      from: "CANCELLED",
      to: "POSTPONE_VOTING"
    });
    expect(channel.send).toHaveBeenCalledTimes(2);
    expect(sentMessages).toHaveLength(2);
    // invariant: postpone メッセージ (2 通目) の id が session に保存される
    const persisted = ctx.ports.sessions.listSessions().find((s) => s.id === session.id);
    expect(persisted?.postponeMessageId).toBe("posted-2");
  });

  it("is idempotent when another path has already cancelled (race)", async () => {
    // race: 別経路で先に CANCELLED に遷移済み → CAS の第一段が no-op で返り、副作用なし。
    const alreadyCancelled = sessionRow({ status: "CANCELLED", cancelReason: "absent" });
    const ctx = createTestAppContext({ seed: { sessions: [alreadyCancelled] } });
    const transitionSpy = vi.spyOn(ctx.ports.sessions, "transitionStatus");

    const { channel } = stubChannel();
    await settleAskingSession(stubClient(channel), ctx, alreadyCancelled.id, "deadline_unanswered");

    // state: findSessionById で non-ASKING を検出し、transitionStatus は呼ばれずに return する。
    expect(transitionSpy).not.toHaveBeenCalled();
    expect(channel.send).not.toHaveBeenCalled();
  });

  it("skips when session status is already non-ASKING", async () => {
    const cancelled = sessionRow({ status: "CANCELLED", cancelReason: "absent" });
    const ctx = createTestAppContext({ seed: { sessions: [cancelled] } });
    const transitionSpy = vi.spyOn(ctx.ports.sessions, "transitionStatus");

    const { channel } = stubChannel();
    await settleAskingSession(stubClient(channel), ctx, cancelled.id, "absent");

    expect(transitionSpy).not.toHaveBeenCalled();
    expect(channel.send).not.toHaveBeenCalled();
  });

  it("uses different cancel copy for absent vs deadline_unanswered", async () => {
    const session = sessionRow();
    const ctx = createTestAppContext({ seed: { sessions: [session] } });

    const { channel } = stubChannel();
    await settleAskingSession(stubClient(channel), ctx, session.id, "deadline_unanswered");

    const firstSend = vi.mocked(channel.send).mock.calls[0]?.[0] as { content: string };
    expect(firstSend.content).toContain("21:30 までに未回答");
  });
});
