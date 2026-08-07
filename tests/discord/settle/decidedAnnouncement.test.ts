import { describe, expect, it } from "vitest";

import type { ResponseRow } from "../../../src/db/rows.js";
import { renderDecidedAnnouncement } from "../../../src/features/decided-announcement/render.js";
import {
  buildDecidedAnnouncementViewModel
} from "../../../src/features/decided-announcement/viewModel.js";
import { appConfig } from "../../../src/userConfig.js";

const decidedStartAt = new Date("2026-04-24T14:00:00.000Z");

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
    answeredAt: new Date(`2026-04-24T12:${String(index).padStart(2, "0")}:00.000Z`),
    sourceInteractionId: null
  }));

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
