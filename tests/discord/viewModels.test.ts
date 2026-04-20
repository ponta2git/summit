// invariant: viewModel は pure (I/O なし、Date.now なし)
// why: DB 型を UI 層から分離 (ADR-0014, naming-boundaries-audit)
import { describe, expect, it } from "vitest";

import {
  buildAskMessageViewModel,
  buildInitialAskMessageViewModel,
  buildPostponeMessageViewModel,
  buildSettleNoticeViewModel,
  type ViewModelMemberInput,
  type ViewModelResponseInput,
  type ViewModelSessionInput
} from "../../src/discord/viewModels.js";
import { env } from "../../src/env.js";

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

  it("uses env.MEMBER_USER_IDS", () => {
    const vm = buildAskMessageViewModel(session, responses, members);
    expect(vm.memberUserIds).toEqual(env.MEMBER_USER_IDS);
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
    expect(vm.memberUserIds).toEqual(env.MEMBER_USER_IDS);
  });

  it("is pure: same inputs produce identical output", () => {
    const input = { id: "s1", candidateDateIso: "2026-04-24" };
    const a = buildPostponeMessageViewModel(input);
    const b = buildPostponeMessageViewModel(input);
    expect(a).toEqual(b);
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

  it("uses env.MEMBER_USER_IDS", () => {
    const vm = buildSettleNoticeViewModel("absent");
    expect(vm.memberUserIds).toEqual(env.MEMBER_USER_IDS);
  });
});
