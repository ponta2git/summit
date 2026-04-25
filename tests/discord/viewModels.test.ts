import { describe, expect, it } from "vitest";

import {
  buildAskMessageViewModel,
  buildInitialAskMessageViewModel,
  buildSettleNoticeViewModel
} from "../../src/features/ask-session/viewModel.js";
import { buildPostponeMessageViewModel } from "../../src/features/postpone-voting/viewModel.js";
import type {
  ViewModelMemberInput,
  ViewModelResponseInput,
  ViewModelSessionInput
} from "../../src/discord/shared/viewModelInputs.js";
import { appConfig } from "../../src/userConfig.js";

const session: ViewModelSessionInput = {
  id: "session-1",
  candidateDateIso: "2026-04-24",
  status: "ASKING",
  decidedStartAt: null
};

const members: ViewModelMemberInput[] = [
  { id: "m1", userId: "u1", displayName: "Alice" },
  { id: "m2", userId: "u2", displayName: "Bob" }
];

const responses: ViewModelResponseInput[] = [
  { memberId: "m1", choice: "T2300" }
];

describe("buildAskMessageViewModel", () => {
  it("is pure: same inputs produce identical output", () => {
    const a = buildAskMessageViewModel(session, responses, members);
    const b = buildAskMessageViewModel(session, responses, members);
    expect(a).toEqual(b);
  });

  it("maps responses by userId via member lookup", () => {
    const vm = buildAskMessageViewModel(session, responses, members);
    expect(vm.responsesByUserId.get("u1")).toBe("T2300");
    expect(vm.responsesByUserId.has("u2")).toBe(false);
  });

  it("builds displayName map", () => {
    const vm = buildAskMessageViewModel(session, responses, members);
    expect(vm.displayNameByUserId.get("u1")).toBe("Alice");
    expect(vm.displayNameByUserId.get("u2")).toBe("Bob");
  });

  it("sets disabled=false when ASKING", () => {
    const vm = buildAskMessageViewModel(session, responses, members);
    expect(vm.disabled).toBe(false);
  });

  it("sets disabled=true when CANCELLED", () => {
    const vm = buildAskMessageViewModel(
      { ...session, status: "CANCELLED" },
      responses,
      members
    );
    expect(vm.disabled).toBe(true);
  });

  it("computes CANCELLED footer", () => {
    const vm = buildAskMessageViewModel(
      { ...session, status: "CANCELLED" },
      [],
      []
    );
    expect(vm.footer).toContain("中止");
  });

  it("computes DECIDED footer with start time", () => {
    const vm = buildAskMessageViewModel(
      { ...session, status: "DECIDED", decidedStartAt: new Date() },
      [
        { memberId: "m1", choice: "T2300" },
        { memberId: "m2", choice: "T2200" }
      ],
      members
    );
    expect(vm.footer).toContain("23:00");
  });

  it("has no footer when ASKING", () => {
    const vm = buildAskMessageViewModel(session, responses, members);
    expect(vm.footer).toBeUndefined();
  });

  it("shows tentative footer when ASKING and all 4 members answered with time choices", () => {
    // regression: §4.3 暫定状態の表示 (@see requirements/base.md)
    const allMembers: ViewModelMemberInput[] = appConfig.memberUserIds.map((userId, i) => ({
      id: `m${i + 1}`,
      userId,
      displayName: `User${i + 1}`
    }));
    const allResponses: ViewModelResponseInput[] = allMembers.map((m, i) => ({
      memberId: m.id,
      // invariant: latest (最遅) = T2300 → 暫定開始時刻 23:00
      choice: (["T2200", "T2230", "T2300", "T2200"] as const)[i] ?? "T2200"
    }));
    const vm = buildAskMessageViewModel(session, allResponses, allMembers);
    expect(vm.footer).toBe("暫定開始時刻: 23:00（21:30 の締切で確定）");
  });

  it("does not show tentative footer when any member answered ABSENT", () => {
    const allMembers: ViewModelMemberInput[] = appConfig.memberUserIds.map((userId, i) => ({
      id: `m${i + 1}`,
      userId,
      displayName: `User${i + 1}`
    }));
    const allResponses: ViewModelResponseInput[] = allMembers.map((m, i) => ({
      memberId: m.id,
      choice: i === 0 ? "ABSENT" : "T2200"
    }));
    const vm = buildAskMessageViewModel(session, allResponses, allMembers);
    expect(vm.footer).toBeUndefined();
  });

  it("does not show tentative footer when a member has not answered yet", () => {
    const allMembers: ViewModelMemberInput[] = appConfig.memberUserIds.map((userId, i) => ({
      id: `m${i + 1}`,
      userId,
      displayName: `User${i + 1}`
    }));
    const partial: ViewModelResponseInput[] = allMembers
      .slice(0, 3)
      .map((m) => ({ memberId: m.id, choice: "T2200" }));
    const vm = buildAskMessageViewModel(session, partial, allMembers);
    expect(vm.footer).toBeUndefined();
  });

  it("uses appConfig.memberUserIds", () => {
    const vm = buildAskMessageViewModel(session, responses, members);
    expect(vm.memberUserIds).toEqual(appConfig.memberUserIds);
  });

  it("ignores responses whose memberId is not in members list", () => {
    const vm = buildAskMessageViewModel(
      session,
      [{ memberId: "unknown-member", choice: "T2200" }],
      members
    );
    expect(vm.responsesByUserId.size).toBe(0);
  });
});

describe("buildInitialAskMessageViewModel", () => {
  it("has empty responses and disabled=false", () => {
    const vm = buildInitialAskMessageViewModel(
      "s1",
      new Date("2026-04-24T00:00:00+09:00"),
      members
    );
    expect(vm.responsesByUserId.size).toBe(0);
    expect(vm.disabled).toBe(false);
    expect(vm.footer).toBeUndefined();
  });

  it("formats candidateDateIso from Date", () => {
    const vm = buildInitialAskMessageViewModel(
      "s1",
      new Date("2026-04-24T00:00:00+09:00"),
      []
    );
    expect(vm.candidateDateIso).toBe("2026-04-24");
  });

  it("is pure: same inputs produce identical output", () => {
    const d = new Date("2026-04-24T00:00:00+09:00");
    const a = buildInitialAskMessageViewModel("s1", d, members);
    const b = buildInitialAskMessageViewModel("s1", d, members);
    expect(a).toEqual(b);
  });
});

describe("buildPostponeMessageViewModel", () => {
  it("carries session fields and env values", () => {
    const vm = buildPostponeMessageViewModel({ id: "s1", candidateDateIso: "2026-04-24" });
    expect(vm.sessionId).toBe("s1");
    expect(vm.candidateDateIso).toBe("2026-04-24");
    expect(vm.memberUserIds).toEqual(appConfig.memberUserIds);
  });

  it("is pure: same inputs produce identical output", () => {
    const input = { id: "s1", candidateDateIso: "2026-04-24" };
    const a = buildPostponeMessageViewModel(input);
    const b = buildPostponeMessageViewModel(input);
    expect(a).toEqual(b);
  });

  it("returns memberStatuses=[] and disabled=false when called with session only (backward compat)", () => {
    const vm = buildPostponeMessageViewModel({ id: "s1", candidateDateIso: "2026-04-24" });
    expect(vm.memberStatuses).toEqual([]);
    expect(vm.disabled).toBe(false);
    expect(vm.footerText).toBeUndefined();
  });

  it("computes member statuses from responses and memberRows", () => {
    const testMembers: ViewModelMemberInput[] = appConfig.memberUserIds.map((userId, i) => ({
      id: `tm${i + 1}`,
      userId,
      displayName: `テスト${i + 1}`
    }));
    const testResponses: ViewModelResponseInput[] = [
      { memberId: "tm1", choice: "POSTPONE_OK" },
      { memberId: "tm2", choice: "POSTPONE_NG" }
    ];
    const vm = buildPostponeMessageViewModel(
      { id: "s2", candidateDateIso: "2026-04-24" },
      testResponses,
      testMembers
    );
    expect(vm.memberStatuses).toHaveLength(appConfig.memberUserIds.length);
    expect(vm.memberStatuses[0]?.state).toBe("ok");
    expect(vm.memberStatuses[1]?.state).toBe("ng");
    expect(vm.memberStatuses[2]?.state).toBe("unanswered");
  });

  it("respects disabled and footerText from options", () => {
    const vm = buildPostponeMessageViewModel(
      { id: "s3", candidateDateIso: "2026-04-24" },
      undefined,
      undefined,
      { disabled: true, footerText: "🛑 見送り" }
    );
    expect(vm.disabled).toBe(true);
    expect(vm.footerText).toBe("🛑 見送り");
  });
});

describe("buildSettleNoticeViewModel", () => {
  it("generates absent cancel text", () => {
    const vm = buildSettleNoticeViewModel("absent");
    expect(vm.cancelText).toContain("欠席");
  });

  it("generates deadline_unanswered cancel text", () => {
    const vm = buildSettleNoticeViewModel("deadline_unanswered");
    expect(vm.cancelText).toContain("21:30");
  });

  it("is pure: same reason produces identical output", () => {
    const a = buildSettleNoticeViewModel("absent");
    const b = buildSettleNoticeViewModel("absent");
    expect(a).toEqual(b);
  });

  it("uses appConfig.memberUserIds", () => {
    const vm = buildSettleNoticeViewModel("absent");
    expect(vm.memberUserIds).toEqual(appConfig.memberUserIds);
  });
});
