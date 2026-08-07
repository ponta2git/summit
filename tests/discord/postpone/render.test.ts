import { describe, expect, it } from "vitest";

import { buildPostponeMessageViewModel } from "../../../src/features/postpone-voting/viewModel.js";
import type {
  ViewModelMemberInput,
  ViewModelResponseInput
} from "../../../src/discord/shared/viewModelInputs.js";
import { renderPostponeBody } from "../../../src/features/postpone-voting/render.js";
import { appConfig } from "../../../src/userConfig.js";

// invariant: テスト内メンバー userId は appConfig.memberUserIds と一致させる (viewModel が appConfig.memberUserIds を走査するため)。
const buildMembers = (): ViewModelMemberInput[] =>
  appConfig.memberUserIds.map((userId, i) => ({
    id: `m${i + 1}`,
    userId,
    displayName: `メンバー${i + 1}`
  }));

const SESSION_ID = "session-postpone-test";
const CANDIDATE_DATE = "2026-04-24";
const mentionLine = appConfig.memberUserIds.map((userId) => `<@${userId}>`).join(" ");
const initialContent = [
  mentionLine,
  "🔁 今回はお流れです。明日も募集しますか？",
  "",
  "元の候補日: 2026-04-24(金) 22:00 以降",
  "順延先: 翌日 22:00 以降",
  "回答締切: 候補日翌日 00:00 JST",
  "",
  "明日も募集OK = 明日もう一度、出欠確認を送ります（参加確定ではありません）",
  "全員分そろえば明日の出欠確認へ進みます。そろわなければ今週はお流れです。"
].join("\n");

const renderedButtons = (rendered: ReturnType<typeof renderPostponeBody>) => {
  const row = rendered.components?.[0];
  if (!row) {throw new Error("expected one postpone action row");}
  return (row as unknown as {
    toJSON: () => {
      components: Array<{
        type: number;
        custom_id?: string;
        label?: string;
        style: number;
        disabled?: boolean;
        emoji?: unknown;
      }>;
    };
  }).toJSON().components;
};

describe("buildPostponeMessageViewModel", () => {
  it("returns memberStatuses=[] when memberRows is omitted (initial-post backward compat)", () => {
    const vm = buildPostponeMessageViewModel({ id: SESSION_ID, candidateDateIso: CANDIDATE_DATE });
    expect(vm).toStrictEqual({
      sessionId: SESSION_ID,
      candidateDateIso: CANDIDATE_DATE,
      memberUserIds: appConfig.memberUserIds,
      suppressMentions: appConfig.dev.suppressMentions,
      memberStatuses: [],
      disabled: false
    });
  });

  it("returns all-unanswered statuses when memberRows provided but responses empty", () => {
    const members = buildMembers();
    const vm = buildPostponeMessageViewModel(
      { id: SESSION_ID, candidateDateIso: CANDIDATE_DATE },
      [],
      members
    );
    expect(vm.memberStatuses).toStrictEqual(members.map((member) => ({
      userId: member.userId,
      displayLabel: member.displayName,
      state: "unanswered"
    })));
  });

  it("maps POSTPONE_OK → 'ok' and POSTPONE_NG → 'ng'", () => {
    const members = buildMembers();
    const responses: ViewModelResponseInput[] = [
      { memberId: "m1", choice: "POSTPONE_OK" },
      { memberId: "m2", choice: "POSTPONE_NG" }
    ];
    const vm = buildPostponeMessageViewModel(
      { id: SESSION_ID, candidateDateIso: CANDIDATE_DATE },
      responses,
      members
    );
    expect(vm.memberStatuses).toStrictEqual([
      { userId: appConfig.memberUserIds[0], displayLabel: "メンバー1", state: "ok" },
      { userId: appConfig.memberUserIds[1], displayLabel: "メンバー2", state: "ng" },
      { userId: appConfig.memberUserIds[2], displayLabel: "メンバー3", state: "unanswered" },
      { userId: appConfig.memberUserIds[3], displayLabel: "メンバー4", state: "unanswered" }
    ]);
  });

  it("falls back to userId as displayLabel when member not found in memberRows", () => {
    // regression: appConfig.memberUserIds にあるが memberRows にない userId のフォールバック
    const partialMembers: ViewModelMemberInput[] = [];
    const vm = buildPostponeMessageViewModel(
      { id: SESSION_ID, candidateDateIso: CANDIDATE_DATE },
      [],
      partialMembers
    );
    expect(vm.memberStatuses[0]?.displayLabel).toBe(appConfig.memberUserIds[0]);
  });

  it("adopts last response for a member when duplicates exist (last-write-wins)", () => {
    const members = buildMembers();
    const userId0 = appConfig.memberUserIds[0];
    // regression: 同一 memberId の複数回答は最後 (配列末尾) が採用される (last-write-wins)
    const responses: ViewModelResponseInput[] = [
      { memberId: "m1", choice: "POSTPONE_OK" },
      { memberId: "m1", choice: "POSTPONE_NG" }
    ];
    const vm = buildPostponeMessageViewModel(
      { id: SESSION_ID, candidateDateIso: CANDIDATE_DATE },
      responses,
      members
    );
    const status = vm.memberStatuses.find((ms) => ms.userId === userId0);
    expect(status?.state).toBe("ng");
  });

  it("sets disabled from options", () => {
    const vm = buildPostponeMessageViewModel(
      { id: SESSION_ID, candidateDateIso: CANDIDATE_DATE },
      undefined,
      undefined,
      { disabled: true }
    );
    expect(vm.disabled).toBe(true);
  });

  it("sets footerText from options", () => {
    const vm = buildPostponeMessageViewModel(
      { id: SESSION_ID, candidateDateIso: CANDIDATE_DATE },
      undefined,
      undefined,
      { footerText: "✅ 順延確定" }
    );
    expect(vm.footerText).toBe("✅ 順延確定");
  });

});

describe("renderPostponeBody", () => {
  it("omits 【順延投票】 section when memberStatuses is empty (initial-post)", () => {
    const vm = buildPostponeMessageViewModel({ id: SESSION_ID, candidateDateIso: CANDIDATE_DATE });
    const rendered = renderPostponeBody(vm);
    expect(rendered.content).toBe(initialContent);
  });

  it("includes 【順延投票】 section with member state lines when memberRows provided", () => {
    const members = buildMembers();
    const responses: ViewModelResponseInput[] = [
      { memberId: "m1", choice: "POSTPONE_OK" },
      { memberId: "m2", choice: "POSTPONE_NG" }
    ];
    const vm = buildPostponeMessageViewModel(
      { id: SESSION_ID, candidateDateIso: CANDIDATE_DATE },
      responses,
      members
    );
    const rendered = renderPostponeBody(vm);
    expect(rendered.content).toBe([
      mentionLine,
      "🔁 今回はお流れです。明日も募集しますか？",
      "",
      "元の候補日: 2026-04-24(金) 22:00 以降",
      "順延先: 翌日 22:00 以降",
      "回答締切: 候補日翌日 00:00 JST",
      "",
      "【順延投票】",
      "- メンバー1: 明日も募集OK",
      "- メンバー2: 今週はお流れ",
      "- メンバー3: 未回答",
      "- メンバー4: 未回答",
      "",
      "明日も募集OK = 明日もう一度、出欠確認を送ります（参加確定ではありません）",
      "全員分そろえば明日の出欠確認へ進みます。そろわなければ今週はお流れです。"
    ].join("\n"));
  });

  it("disables buttons when vm.disabled=true", () => {
    const vm = buildPostponeMessageViewModel(
      { id: SESSION_ID, candidateDateIso: CANDIDATE_DATE },
      undefined,
      undefined,
      { disabled: true }
    );
    const rendered = renderPostponeBody(vm);
    expect(renderedButtons(rendered).map((button) => button.disabled)).toStrictEqual([true, true]);
  });

  it("appends footerText after 1 blank line at the end of content", () => {
    const vm = buildPostponeMessageViewModel(
      { id: SESSION_ID, candidateDateIso: CANDIDATE_DATE },
      undefined,
      undefined,
      { footerText: "✅ 順延確定" }
    );
    const rendered = renderPostponeBody(vm);
    expect(rendered.content).toBe(`${initialContent}\n\n✅ 順延確定`);
  });

  it("builds postpone custom ids for ok and ng buttons", () => {
    const vm = buildPostponeMessageViewModel({ id: SESSION_ID, candidateDateIso: CANDIDATE_DATE });
    const rendered = renderPostponeBody(vm);
    expect(rendered.components).toHaveLength(1);
    expect(renderedButtons(rendered)).toStrictEqual([
      {
        type: 2,
        custom_id: `postpone:${SESSION_ID}:ok`,
        label: "明日も募集OK",
        style: 1,
        disabled: false,
        emoji: undefined
      },
      {
        type: 2,
        custom_id: `postpone:${SESSION_ID}:ng`,
        label: "今週はお流れ",
        style: 2,
        disabled: false,
        emoji: undefined
      }
    ]);
  });
});
