import { ChannelType, type Client } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ResponseRow, SessionRow } from "../../../src/db/types.js";
import {
  sendDecidedAnnouncement,
  renderDecidedAnnouncement
} from "../../../src/features/decided-announcement/send.js";
import {
  buildDecidedAnnouncementViewModel
} from "../../../src/features/decided-announcement/viewModel.js";
import { env } from "../../../src/env.js";
import { createTestAppContext } from "../../testing/index.js";
import { buildSessionRow } from "../factories/session.js";

const decidedStartAt = new Date("2026-04-24T14:00:00.000Z"); // JST 23:00
const decidedSession = (overrides: Partial<SessionRow> = {}): SessionRow =>
  buildSessionRow({
    id: "session-decided-1",
    askMessageId: "ask-msg-1",
    status: "DECIDED",
    decidedStartAt,
    reminderAt: new Date(decidedStartAt.getTime() - 15 * 60_000),
    reminderSentAt: null,
    ...overrides
  });

const seededMembers = env.MEMBER_USER_IDS.map((userId, index) => ({
  id: `member-${index + 1}`,
  userId,
  displayName: `表示名${index + 1}`
}));

const allTimeSlotResponses = (): ResponseRow[] =>
  (["T2200", "T2230", "T2300", "T2330"] as const).map((choice, index) => ({
    id: `response-${index + 1}`,
    sessionId: "session-decided-1",
    memberId: seededMembers[index]!.id,
    choice,
    answeredAt: new Date(`2026-04-24T12:${String(index).padStart(2, "0")}:00.000Z`)
  }));

const stubChannel = () => {
  const send = vi.fn(async (_payload: unknown) => ({ id: "decided-msg-id" }));
  const channel = {
    type: ChannelType.GuildText,
    isSendable: () => true,
    send,
    messages: { fetch: vi.fn() }
  };
  const client = {
    channels: { fetch: vi.fn(async () => channel) }
  } as unknown as Client;
  return { channel, client, send };
};

describe("buildDecidedAnnouncementViewModel", () => {
  it("returns undefined when decidedStartAt is null", () => {
    const vm = buildDecidedAnnouncementViewModel(
      { decidedStartAt: null },
      [],
      seededMembers
    );
    expect(vm).toBeUndefined();
  });

  it("formats startTimeLabel in JST HH:MM and orders member lines by MEMBER_USER_IDS", () => {
    // regression: JST (Asia/Tokyo) 固定の HH:MM 整形と MEMBER_USER_IDS 順を担保
    const vm = buildDecidedAnnouncementViewModel(
      { decidedStartAt },
      allTimeSlotResponses(),
      seededMembers
    );
    expect(vm).toBeDefined();
    expect(vm?.startTimeLabel).toBe("23:00");
    expect(vm?.memberLines).toHaveLength(env.MEMBER_USER_IDS.length);
    expect(vm?.memberLines.map((l) => l.slotLabel)).toEqual([
      "22:00",
      "22:30",
      "23:00",
      "23:30"
    ]);
  });

  it("renders '-' when a member has no response (defensive fallback)", () => {
    const vm = buildDecidedAnnouncementViewModel(
      { decidedStartAt },
      allTimeSlotResponses().slice(0, 2),
      seededMembers
    );
    expect(vm?.memberLines[2]?.slotLabel).toBe("-");
    expect(vm?.memberLines[3]?.slotLabel).toBe("-");
  });
});

describe("renderDecidedAnnouncement", () => {
  it("prepends mention line when suppressMentions is false", () => {
    const content = renderDecidedAnnouncement({
      startTimeLabel: "23:00",
      memberUserIds: ["u1", "u2"],
      suppressMentions: false,
      memberLines: [
        { displayName: "A", slotLabel: "22:30" },
        { displayName: "Bee", slotLabel: "23:00" }
      ]
    }).content;
    expect(content.startsWith("<@u1> <@u2>\n")).toBe(true);
    expect(content).toContain("🎉 今週の桃鉄1年勝負は開催します！");
    expect(content).toContain("開始時刻: 23:00");
    expect(content).toContain("回答内訳:");
    expect(content).toContain("- A   : 22:30");
    expect(content).toContain("- Bee : 23:00");
  });

  it("omits mention line when suppressMentions is true", () => {
    const content = renderDecidedAnnouncement({
      startTimeLabel: "23:00",
      memberUserIds: ["u1"],
      suppressMentions: true,
      memberLines: [{ displayName: "A", slotLabel: "22:30" }]
    }).content;
    expect(content).not.toContain("<@u1>");
    expect(content.startsWith("🎉")).toBe(true);
  });
});

describe("sendDecidedAnnouncement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends the announcement with mentions and member breakdown for DECIDED session", async () => {
    const session = decidedSession();
    const responses = allTimeSlotResponses();
    const ctx = createTestAppContext({
      seed: { sessions: [session], responses, members: seededMembers }
    });
    const { client, send } = stubChannel();

    await sendDecidedAnnouncement(client, ctx, session);

    expect(send).toHaveBeenCalledTimes(1);
    const payload = send.mock.calls[0]?.[0] as { content: string };
    for (const userId of env.MEMBER_USER_IDS) {
      expect(payload.content).toContain(`<@${userId}>`);
    }
    expect(payload.content).toContain("🎉 今週の桃鉄1年勝負は開催します！");
    expect(payload.content).toContain("開始時刻: 23:00");
  });

  it("does not send when session is not DECIDED", async () => {
    const session = decidedSession({ status: "ASKING" });
    const ctx = createTestAppContext({ seed: { sessions: [session], members: seededMembers } });
    const { client, send } = stubChannel();

    await sendDecidedAnnouncement(client, ctx, session);

    expect(send).not.toHaveBeenCalled();
  });

  it("does not send when decidedStartAt is null", async () => {
    const session = decidedSession({ decidedStartAt: null });
    const ctx = createTestAppContext({ seed: { sessions: [session], members: seededMembers } });
    const { client, send } = stubChannel();

    await sendDecidedAnnouncement(client, ctx, session);

    expect(send).not.toHaveBeenCalled();
  });

  it("omits mention line when DEV_SUPPRESS_MENTIONS is true", async () => {
    const originalFlag = env.DEV_SUPPRESS_MENTIONS;
    (env as unknown as { DEV_SUPPRESS_MENTIONS: boolean }).DEV_SUPPRESS_MENTIONS = true;
    try {
      const session = decidedSession();
      const responses = allTimeSlotResponses();
      const ctx = createTestAppContext({
        seed: { sessions: [session], responses, members: seededMembers }
      });
      const { client, send } = stubChannel();

      await sendDecidedAnnouncement(client, ctx, session);

      const payload = send.mock.calls[0]?.[0] as { content: string };
      for (const userId of env.MEMBER_USER_IDS) {
        expect(payload.content).not.toContain(`<@${userId}>`);
      }
    } finally {
      (env as unknown as { DEV_SUPPRESS_MENTIONS: boolean }).DEV_SUPPRESS_MENTIONS = originalFlag;
    }
  });

  it("swallows channel send failures without throwing (DB-as-SoT, retry not attempted)", async () => {
    const session = decidedSession();
    const responses = allTimeSlotResponses();
    const ctx = createTestAppContext({
      seed: { sessions: [session], responses, members: seededMembers }
    });
    const client = {
      channels: {
        fetch: vi.fn(async () => {
          throw new Error("fetch failed");
        })
      }
    } as unknown as Client;

    await expect(sendDecidedAnnouncement(client, ctx, session)).resolves.toBeUndefined();
  });
});
