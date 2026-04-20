// why: DB 型を UI 層から分離 (ADR-0014, naming-boundaries-audit)
// source-of-truth: renderPostponeBody は vm.memberStatuses → statusLines → messages.postpone.body の
//   pipeline で組み立てる。DB 型に依存しない。
import { describe, expect, it } from "vitest";

import {
  buildPostponeMessageViewModel,
  type ViewModelMemberInput,
  type ViewModelResponseInput
} from "../../../src/discord/viewModels.js";
import { renderPostponeBody } from "../../../src/discord/postpone/render.js";
import { env } from "../../../src/env.js";

// invariant: テスト内メンバーの userId は env.MEMBER_USER_IDS と一致させる（buildPostponeMessageViewModel
//   が env.MEMBER_USER_IDS を走査するため）。
const buildMembers = (): ViewModelMemberInput[] =>
  env.MEMBER_USER_IDS.map((userId, i) => ({
    id: `m${i + 1}`,
    userId,
    displayName: `メンバー${i + 1}`
  }));

const SESSION_ID = "session-postpone-test";
const CANDIDATE_DATE = "2026-04-24";

describe("buildPostponeMessageViewModel", () => {
  it("returns memberStatuses=[] when memberRows is omitted (initial-post backward compat)", () => {
    const vm = buildPostponeMessageViewModel({ id: SESSION_ID, candidateDateIso: CANDIDATE_DATE });
    expect(vm.memberStatuses).toEqual([]);
    expect(vm.disabled).toBe(false);
    expect(vm.footerText).toBeUndefined();
  });

  it("returns all-unanswered statuses when memberRows provided but responses empty", () => {
    const members = buildMembers();
    const vm = buildPostponeMessageViewModel(
      { id: SESSION_ID, candidateDateIso: CANDIDATE_DATE },
      [],
      members
    );
    expect(vm.memberStatuses).toHaveLength(env.MEMBER_USER_IDS.length);
    for (const ms of vm.memberStatuses) {
      expect(ms.state).toBe("unanswered");
    }
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
    expect(vm.memberStatuses[0]?.state).toBe("ok");
    expect(vm.memberStatuses[1]?.state).toBe("ng");
    expect(vm.memberStatuses[2]?.state).toBe("unanswered");
    expect(vm.memberStatuses[3]?.state).toBe("unanswered");
  });

  it("uses displayName from member as displayLabel", () => {
    const members = buildMembers();
    const vm = buildPostponeMessageViewModel(
      { id: SESSION_ID, candidateDateIso: CANDIDATE_DATE },
      [],
      members
    );
    expect(vm.memberStatuses[0]?.displayLabel).toBe("メンバー1");
  });

  it("falls back to userId as displayLabel when member not found in memberRows", () => {
    // regression: env.MEMBER_USER_IDS にあるが memberRows にない userId のフォールバック確認
    const partialMembers: ViewModelMemberInput[] = [];
    const vm = buildPostponeMessageViewModel(
      { id: SESSION_ID, candidateDateIso: CANDIDATE_DATE },
      [],
      partialMembers
    );
    expect(vm.memberStatuses[0]?.displayLabel).toBe(env.MEMBER_USER_IDS[0]);
  });

  it("adopts last response for a member when duplicates exist (last-write-wins)", () => {
    const members = buildMembers();
    const userId0 = env.MEMBER_USER_IDS[0];
    // regression: 同一 memberId で複数回答 → 最後 (配列末尾) が採用される
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

  it("is pure: same inputs produce identical output", () => {
    const members = buildMembers();
    const responses: ViewModelResponseInput[] = [{ memberId: "m1", choice: "POSTPONE_OK" }];
    const a = buildPostponeMessageViewModel(
      { id: SESSION_ID, candidateDateIso: CANDIDATE_DATE },
      responses,
      members,
      { disabled: false }
    );
    const b = buildPostponeMessageViewModel(
      { id: SESSION_ID, candidateDateIso: CANDIDATE_DATE },
      responses,
      members,
      { disabled: false }
    );
    expect(a).toEqual(b);
  });
});

describe("renderPostponeBody", () => {
  it("omits 【順延投票】 section when memberStatuses is empty (initial-post)", () => {
    const vm = buildPostponeMessageViewModel({ id: SESSION_ID, candidateDateIso: CANDIDATE_DATE });
    const rendered = renderPostponeBody(vm);
    expect(rendered.content).not.toContain("【順延投票】");
    expect(rendered.content).toContain("🔁");
    expect(rendered.content).toContain("全員が OK を押せば順延確定");
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
    expect(rendered.content).toContain("【順延投票】");
    expect(rendered.content).toContain("- メンバー1: OK");
    expect(rendered.content).toContain("- メンバー2: NG");
    expect(rendered.content).toContain("- メンバー3: 未回答");
    expect(rendered.content).toContain("- メンバー4: 未回答");
  });

  it("disables buttons when vm.disabled=true", () => {
    const vm = buildPostponeMessageViewModel(
      { id: SESSION_ID, candidateDateIso: CANDIDATE_DATE },
      undefined,
      undefined,
      { disabled: true }
    );
    const rendered = renderPostponeBody(vm);
    const row = rendered.components?.[0] as unknown as {
      toJSON?: () => { components: { disabled?: boolean }[] };
    };
    const json = row?.toJSON?.();
    expect(json?.components.every((c) => c.disabled === true)).toBe(true);
  });

  it("leaves buttons enabled when vm.disabled=false (default)", () => {
    const vm = buildPostponeMessageViewModel({ id: SESSION_ID, candidateDateIso: CANDIDATE_DATE });
    const rendered = renderPostponeBody(vm);
    const row = rendered.components?.[0] as unknown as {
      toJSON?: () => { components: { disabled?: boolean }[] };
    };
    const json = row?.toJSON?.();
    expect(json?.components.every((c) => c.disabled !== true)).toBe(true);
  });

  it("appends footerText after 1 blank line at the end of content", () => {
    const vm = buildPostponeMessageViewModel(
      { id: SESSION_ID, candidateDateIso: CANDIDATE_DATE },
      undefined,
      undefined,
      { footerText: "✅ 順延確定" }
    );
    const rendered = renderPostponeBody(vm);
    // invariant: footerText は本文末尾（全員〜行）の後に 1 空行を挟んで追加される
    expect(rendered.content).toContain("全員が OK を押せば順延確定、1人でも NG / 未回答なら今週はお流れです。\n\n✅ 順延確定");
  });

  it("includes mention line when suppressMentions=false (default)", () => {
    const vm = buildPostponeMessageViewModel({ id: SESSION_ID, candidateDateIso: CANDIDATE_DATE });
    const rendered = renderPostponeBody(vm);
    // why: DEV_SUPPRESS_MENTIONS=false(テストデフォルト) では mention 行が先頭に来る
    for (const userId of env.MEMBER_USER_IDS) {
      expect(rendered.content).toContain(`<@${userId}>`);
    }
  });

  it("has exactly one ActionRow component", () => {
    const vm = buildPostponeMessageViewModel({ id: SESSION_ID, candidateDateIso: CANDIDATE_DATE });
    const rendered = renderPostponeBody(vm);
    expect(rendered.components).toHaveLength(1);
  });

  it("builds postpone custom ids for ok and ng buttons", () => {
    const vm = buildPostponeMessageViewModel({ id: SESSION_ID, candidateDateIso: CANDIDATE_DATE });
    const rendered = renderPostponeBody(vm);
    const row = rendered.components?.[0] as unknown as {
      toJSON?: () => { components: { custom_id?: string }[] };
    };
    const ids = row?.toJSON?.().components.map((c) => c.custom_id);
    expect(ids).toEqual([
      `postpone:${SESSION_ID}:ok`,
      `postpone:${SESSION_ID}:ng`
    ]);
  });
});
