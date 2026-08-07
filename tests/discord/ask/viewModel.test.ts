import { describe, expect, it } from "vitest";

import type {
  ViewModelMemberInput,
  ViewModelResponseInput,
  ViewModelSessionInput
} from "../../../src/discord/shared/viewModelInputs.js";
import {
  buildAskMessageViewModel,
  type AskMessageViewModel
} from "../../../src/features/ask-session/viewModel.js";
import { appConfig } from "../../../src/userConfig.js";

const session: ViewModelSessionInput = {
  id: "session-1",
  candidateDateIso: "2026-04-24",
  status: "ASKING",
  decidedStartAt: null
};

const members: ViewModelMemberInput[] = appConfig.memberUserIds.map((userId, index) => ({
  id: `member-${index + 1}`,
  userId,
  displayName: `Member ${index + 1}`
}));

const expectedViewModel = (
  overrides: Partial<AskMessageViewModel> = {}
): AskMessageViewModel => ({
  sessionId: session.id,
  candidateDateIso: session.candidateDateIso,
  disabled: false,
  memberUserIds: appConfig.memberUserIds,
  responsesByUserId: new Map(),
  displayNameByUserId: new Map(),
  suppressMentions: appConfig.dev.suppressMentions,
  footer: undefined,
  ...overrides
});

describe("buildAskMessageViewModel", () => {
  it("maps the complete ASKING view model through member ids", () => {
    const responses: ViewModelResponseInput[] = [
      { memberId: members[0]!.id, choice: "T2300" }
    ];

    expect(buildAskMessageViewModel(session, responses, members)).toStrictEqual(
      expectedViewModel({
        responsesByUserId: new Map([[appConfig.memberUserIds[0]!, "T2300"]]),
        displayNameByUserId: new Map(
          members.map((member) => [member.userId, member.displayName])
        )
      })
    );
  });

  it("excludes unknown members and non-ask response choices", () => {
    const responses: ViewModelResponseInput[] = [
      { memberId: "unknown-member", choice: "T2200" },
      { memberId: members[0]!.id, choice: "POSTPONE_OK" }
    ];

    expect(buildAskMessageViewModel(session, responses, members)).toStrictEqual(
      expectedViewModel({
        displayNameByUserId: new Map(
          members.map((member) => [member.userId, member.displayName])
        )
      })
    );
  });

  it.each([
    {
      label: "CANCELLED",
      input: { status: "CANCELLED" as const, decidedStartAt: null },
      footer: "🛑 今回はお流れです。回答は締め切りました"
    },
    {
      label: "SKIPPED",
      input: { status: "SKIPPED" as const, decidedStartAt: null },
      footer: "🛑 今週の出欠確認はお休みです"
    },
    {
      label: "DECIDED",
      input: {
        status: "DECIDED" as const,
        decidedStartAt: new Date("2026-04-24T14:00:00.000Z")
      },
      footer: "✅ みんなの回答がそろいました。23:00 開始で確定です（開催決定を投稿します）"
    }
  ])("builds the complete $label terminal view model", ({ input, footer }) => {
    expect(buildAskMessageViewModel({ ...session, ...input }, [], [])).toStrictEqual(
      expectedViewModel({ disabled: true, footer })
    );
  });

  it("shows the latest feasible slot while all configured members have answered", () => {
    const choices = ["T2200", "T2230", "T2300", "T2200"] as const;
    const responses = members.map((member, index) => ({
      memberId: member.id,
      choice: choices[index]!
    }));

    expect(buildAskMessageViewModel(session, responses, members)).toStrictEqual(
      expectedViewModel({
        responsesByUserId: new Map(
          members.map((member, index) => [member.userId, choices[index]!])
        ),
        displayNameByUserId: new Map(
          members.map((member) => [member.userId, member.displayName])
        ),
        footer: "いまの見込み: 23:00 開始（21:30 に確定）"
      })
    );
  });

  it.each([
    {
      label: "one member is absent",
      responses: members.map((member, index) => ({
        memberId: member.id,
        choice: index === 0 ? ("ABSENT" as const) : ("T2200" as const)
      }))
    },
    {
      label: "one member is unanswered",
      responses: members.slice(0, -1).map((member) => ({
        memberId: member.id,
        choice: "T2200" as const
      }))
    }
  ])("omits the tentative footer when $label", ({ responses }) => {
    expect(buildAskMessageViewModel(session, responses, members).footer).toBeUndefined();
  });
});
