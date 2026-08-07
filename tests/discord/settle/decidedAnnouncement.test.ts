import { describe, expect, it } from "vitest";

import type { ResponseRow, SessionRow } from "../../../src/db/rows.js";
import {
  sendDecidedAnnouncement,
  renderDecidedAnnouncement
} from "../../../src/features/decided-announcement/send.js";
import {
  buildDecidedAnnouncementViewModel
} from "../../../src/features/decided-announcement/viewModel.js";
import { appConfig } from "../../../src/userConfig.js";
import { asDiscordClient } from "../../helpers/discord.js";
import { createTestAppContext } from "../../testing/index.js";
import { buildSessionRow } from "../factories/session.js";

const decidedStartAt = new Date("2026-04-24T14:00:00.000Z");
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

const seededMembers = appConfig.memberUserIds.map((userId, index) => ({
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

const stubClient = asDiscordClient({});

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
    // regression: JST (Asia/Tokyo) 固定の HH:MM 整形と MEMBER_USER_IDS 順
    const vm = buildDecidedAnnouncementViewModel(
      { decidedStartAt },
      allTimeSlotResponses(),
      seededMembers
    );
    expect(vm).toStrictEqual({
      startTimeLabel: "23:00",
      memberUserIds: appConfig.memberUserIds,
      suppressMentions: appConfig.dev.suppressMentions,
      memberLines: [
        { displayName: "表示名1", slotLabel: "22:00" },
        { displayName: "表示名2", slotLabel: "22:30" },
        { displayName: "表示名3", slotLabel: "23:00" },
        { displayName: "表示名4", slotLabel: "23:30" }
      ]
    });
  });

  it("renders '-' when a member has no response (defensive fallback)", () => {
    const vm = buildDecidedAnnouncementViewModel(
      { decidedStartAt },
      allTimeSlotResponses().slice(0, 2),
      seededMembers
    );
    expect(vm?.memberLines).toStrictEqual([
      { displayName: "表示名1", slotLabel: "22:00" },
      { displayName: "表示名2", slotLabel: "22:30" },
      { displayName: "表示名3", slotLabel: "-" },
      { displayName: "表示名4", slotLabel: "-" }
    ]);
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
    expect(content).toBe(
      "<@u1> <@u2>\n" +
      "🎉 今週の桃鉄1年勝負、開催です！\n" +
      "\n" +
      "開始: 23:00\n" +
      "回答内訳:\n" +
      "- A   : 22:30\n" +
      "- Bee : 23:00"
    );
  });

  it("omits mention line when suppressMentions is true", () => {
    const content = renderDecidedAnnouncement({
      startTimeLabel: "23:00",
      memberUserIds: ["u1"],
      suppressMentions: true,
      memberLines: [{ displayName: "A", slotLabel: "22:30" }]
    }).content;
    expect(content).toBe(
      "🎉 今週の桃鉄1年勝負、開催です！\n" +
      "\n" +
      "開始: 23:00\n" +
      "回答内訳:\n" +
      "- A : 22:30"
    );
  });
});

describe("sendDecidedAnnouncement", () => {
  it("enqueues a decided_announcement outbox entry with stable dedupeKey", async () => {
    const session = decidedSession();
    const responses = allTimeSlotResponses();
    const ctx = createTestAppContext({
      now: new Date("2026-04-24T12:31:00.000Z"),
      seed: { sessions: [session], responses, members: seededMembers }
    });

    await sendDecidedAnnouncement(stubClient, ctx, session);

    const entries = ctx.ports.outbox.listEntries();
    expect(entries.map((entry) => ({
      kind: entry.kind,
      sessionId: entry.sessionId,
      dedupeKey: entry.dedupeKey,
      payload: entry.payload,
      status: entry.status,
      attemptCount: entry.attemptCount
    }))).toStrictEqual([{
      kind: "send_message",
      sessionId: session.id,
      dedupeKey: `decided-announcement-${session.id}`,
      payload: {
        kind: "send_message",
        channelId: session.channelId,
        renderer: "decided_announcement",
        extra: {}
      },
      status: "PENDING",
      attemptCount: 0
    }]);
  });

  it("does not enqueue when session is not DECIDED", async () => {
    const session = decidedSession({ status: "ASKING" });
    const ctx = createTestAppContext({ seed: { sessions: [session], members: seededMembers } });

    await sendDecidedAnnouncement(stubClient, ctx, session);

    expect(ctx.ports.outbox.listEntries()).toStrictEqual([]);
  });

  it("does not enqueue when decidedStartAt is null", async () => {
    const session = decidedSession({ decidedStartAt: null });
    const ctx = createTestAppContext({ seed: { sessions: [session], members: seededMembers } });

    await sendDecidedAnnouncement(stubClient, ctx, session);

    expect(ctx.ports.outbox.listEntries()).toStrictEqual([]);
  });

  it("dedupes repeated enqueue for same session (idempotent)", async () => {
    const session = decidedSession();
    const responses = allTimeSlotResponses();
    const ctx = createTestAppContext({
      seed: { sessions: [session], responses, members: seededMembers }
    });

    await sendDecidedAnnouncement(stubClient, ctx, session);
    await sendDecidedAnnouncement(stubClient, ctx, session);

    expect(ctx.ports.outbox.listEntries().map((entry) => entry.dedupeKey)).toStrictEqual([
      `decided-announcement-${session.id}`
    ]);
  });
});
