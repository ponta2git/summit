import { describe, expect, it } from "vitest";

import { renderAskBody } from "../../../src/features/ask-session/render.js";
import type { AskMessageViewModel } from "../../../src/features/ask-session/viewModel.js";

const renderedRows = (rendered: ReturnType<typeof renderAskBody>): readonly unknown[] =>
  rendered.components?.map((component) =>
    (component as unknown as { readonly toJSON: () => unknown }).toJSON()
  ) ?? [];

const viewModel = (overrides: Partial<AskMessageViewModel> = {}): AskMessageViewModel => ({
  sessionId: "session-id",
  candidateDateIso: "2026-04-24",
  disabled: false,
  memberUserIds: ["u1", "u2"],
  responsesByUserId: new Map([["u1", "T2330"]]),
  displayNameByUserId: new Map([
    ["u1", "Alice"],
    ["u2", "Bob"]
  ]),
  suppressMentions: false,
  footer: "いまの見込み: 23:30 開始（21:30 に確定）",
  ...overrides
});

describe("renderAskBody", () => {
  it("renders the complete message and interactive button contract", () => {
    const rendered = renderAskBody(viewModel());

    expect({
      content: rendered.content,
      components: renderedRows(rendered)
    }).toStrictEqual({
      content: [
        "<@u1> <@u2>",
        "🎲 今週の桃鉄1年勝負、出欠確認です",
        "",
        "開催候補日: 2026-04-24(金) 22:00 以降",
        "回答締切: 21:30",
        "ボタン: 参加できる一番早い時間を選んでください",
        "補足: 23:00 を選ぶと 23:00/23:30 に参加できるものとして集計します",
        "予定が合わない場合は「今回は欠席」を選んでください（今回はお流れになります）",
        "",
        "回答状況",
        "- Alice : 23:30",
        "- Bob : 未回答",
        "",
        "いまの見込み: 23:30 開始（21:30 に確定）"
      ].join("\n"),
      components: [{
        type: 1,
        components: [
          {
            type: 2,
            custom_id: "ask:session-id:t2200",
            label: "22:00",
            style: 2,
            disabled: false,
            emoji: undefined
          },
          {
            type: 2,
            custom_id: "ask:session-id:t2230",
            label: "22:30",
            style: 2,
            disabled: false,
            emoji: undefined
          },
          {
            type: 2,
            custom_id: "ask:session-id:t2300",
            label: "23:00",
            style: 2,
            disabled: false,
            emoji: undefined
          },
          {
            type: 2,
            custom_id: "ask:session-id:t2330",
            label: "23:30",
            style: 2,
            disabled: false,
            emoji: undefined
          },
          {
            type: 2,
            custom_id: "ask:session-id:absent",
            label: "今回は欠席",
            style: 4,
            disabled: false,
            emoji: undefined
          }
        ]
      }]
    });
  });

  it("disables every response button for a settled session", () => {
    const rendered = renderAskBody(viewModel({ disabled: true }));
    const rows = renderedRows(rendered) as ReadonlyArray<{
      readonly components: ReadonlyArray<{ readonly disabled?: boolean }>;
    }>;

    expect(rows.flatMap((row) => row.components.map((button) => button.disabled))).toStrictEqual([
      true,
      true,
      true,
      true,
      true
    ]);
  });
});
