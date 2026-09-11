import { MessageFlags } from "discord.js";
import { describe, expect, it } from "vitest";

import { renderResultNotification } from "../../../src/features/result-notifications/render.ts";
import { renderNotificationRanks } from "../../../src/features/result-notifications/ranks.ts";
import { analysisNotification, ocrNotification, rankComparisons } from "./fixtures.ts";

const origin = "https://results.example.com";

describe("fixed result notification rendering", () => {
  it("renders the complete OCR confirmation from its snapshot", () => {
    expect(renderResultNotification(ocrNotification(), origin)).toStrictEqual({
      rendererVersion: 1,
      parts: [{
        content: [
          "OCR完了 1/1",
          "OCR完了: 要確認",
          "画像種別: 総資産",
          "作品: テスト作品",
          "開催日: 2026-09-08",
          "試合番号: 第2試合",
          "処理日時: 2026-09-09 21:00:00 JST",
          "",
          "要約: 読み取りが完了しました。内容を確認してください。",
          "",
          "下書きを確認: <https://results.example.com/review/draft-1>"
        ].join("\n"),
        allowedMentions: { parse: [], users: [], roles: [], repliedUser: false },
        flags: MessageFlags.SuppressEmbeds
      }]
    });
  });

  it.each([
    ["revenue", "物件収益"],
    ["incident_log", "事件簿"]
  ] as const)("shows successful %s and omits unknown context", (screenType, label) => {
    const input = ocrNotification();
    const rendered = renderResultNotification({ ...input, data: {
      ...input.data, screenType, outcome: "succeeded",
      context: { gameTitleName: null, heldDateIso: null, matchNoInEvent: null }
    } }, origin);
    const content = rendered.parts[0]?.content;
    expect(content).toContain(`OCR完了: 成功\n画像種別: ${label}\n処理日時:`);
    expect(content).not.toMatch(/作品:|開催日:|試合番号:/);
  });

  it("keeps all four ranks, both aggregates, ginji, full notes, and authenticated routes", () => {
    const input = analysisNotification();
    const saved = structuredClone(input);
    const rendered = renderResultNotification(input, origin);
    const text = rendered.parts.map(part => part.content).join("\n");
    expect(text).toContain("通知の基準日時: 2026-09-09 21:00:00 JST");
    expect(text).toContain("作品通算（全マップ）: 前回成功分析 → 今回");
    expect(text).toContain("シーズン通算（全マップ）: 2026年度");
    expect(text).toContain([
      "葵: 2.50位（4試合） → 2.20位（5試合） / 差分 -0.30（改善）",
      "楓: 2.50位（4試合） → 2.60位（5試合） / 差分 +0.10（後退）",
      "凪: 2.50位（4試合） → 2.50位（5試合） / 差分 0.00（維持）",
      "蓮: 2.50位（4試合） → 2.50位（5試合） / 差分 +0.01未満（後退）"
    ].join("\n"));
    expect(text).toContain([
      "開催日: 2026-09-08 / 第2試合",
      "プレイ日時: 2026-09-09 00:30:00 JST",
      "マップ: 東日本 / シーズン: 2026年度",
      "オーナー: 葵",
      "1位 葵 / 銀次 0回",
      "2位 楓 / 銀次 2回",
      "3位 凪 / 銀次 1回",
      "4位 蓮 / 銀次 0回",
      "この試合の銀次合計: 3回",
      "メモ:\n最終年に逆転。\n楽しい試合でした。",
      "試合を確認: <https://results.example.com/matches/match-1>"
    ].join("\n"));
    expect(text).toContain("最新の分析を確認: <https://results.example.com/analytics/series?gameTitleId=title-1>");
    expect(input).toStrictEqual(saved);
    expect(renderResultNotification(input, origin)).toStrictEqual(rendered);
  });

  it("distinguishes first, empty, incomparable, reused, and small improvements", () => {
    const rank = rankComparisons()[0];
    expect(renderNotificationRanks([
      { ...rank, before: null, delta: null, comparison: "initial" },
      { ...rank, after: { averageRank: null, matchCount: 0 }, delta: null, comparison: "empty" },
      { ...rank, delta: null, comparison: "incomparable" },
      { ...rank, before: rank.after, delta: 0, comparison: "reused" },
      { ...rank, delta: -0.00001 }
    ])).toStrictEqual([
      "葵: 前回なし → 2.20位（5試合） / 初回",
      "葵: 2.50位（4試合） → 対象なし（0試合） / 対象なし",
      "葵: 2.50位（4試合） → 2.20位（5試合） / 比較不可",
      "葵: 2.20位（5試合） → 2.20位（5試合） / 再利用（比較の更新なし）",
      "葵: 2.50位（4試合） → 2.20位（5試合） / 差分 -0.01未満（改善）"
    ].join("\n"));
  });

  it("does not describe no changed matches as zero ginji", () => {
    const input = analysisNotification();
    const result = renderResultNotification({ ...input, data: {
      ...input.data, disposition: "reused", matches: []
    } }, origin);
    const text = result.parts.map(part => part.content).join("\n");
    expect(text).toContain("分析完了（既存分析を再利用）");
    expect(text).toContain("追加・変更試合: なし");
    expect(text).not.toContain("銀次");
  });

  it("summarizes all-zero ginji and omits an unentered memo", () => {
    const input = analysisNotification();
    const result = renderResultNotification({ ...input, data: {
      ...input.data, matches: input.data.matches.map(match => ({
        ...match, note: null, ginjiTotal: 0,
        players: [
          { ...match.players[0], ginjiCount: 0 }, { ...match.players[1], ginjiCount: 0 },
          { ...match.players[2], ginjiCount: 0 }, { ...match.players[3], ginjiCount: 0 }
        ]
      }))
    } }, origin);
    const text = result.parts.map(part => part.content).join("\n");
    expect(text).toContain("今回の対象試合は銀次なし（全員0回）");
    expect(text).toContain("この試合の銀次合計: 0回");
    expect(text).not.toContain("メモ:");
  });

  it("keeps long Markdown and Unicode notes across numbered parts with mentions disabled", () => {
    const input = analysisNotification();
    const match = input.data.matches[0];
    if (!match) { throw new Error("Fixture needs a match."); }
    const note = "[x] `raw` *text* 😀 @everyone <@123>\\".repeat(300);
    const result = renderResultNotification({ ...input, data: {
      ...input.data, matches: [{ ...match, note }]
    } }, origin);
    expect(result.parts.length).toBeGreaterThan(3);
    const rejoined = result.parts.map((part, index) => {
      expect(part.content.length).toBeLessThanOrEqual(2_000);
      expect(part.content).toMatch(new RegExp(`^分析完了 ${index + 1}/${result.parts.length}`));
      expect(part.allowedMentions).toStrictEqual({ parse: [], users: [], roles: [], repliedUser: false });
      expect(part.content).not.toContain("\ufffd");
      return part.content.slice(part.content.indexOf("\n") + 1);
    }).join("");
    expect(rejoined).toContain("\\[x\\] \\`raw\\` \\*text\\* 😀 @everyone \\<@123\\>\\\\".repeat(300));
    expect(rejoined).toContain("試合を確認: <https://results.example.com/matches/match-1>");
  });

  it("encodes IDs in their intended route and rejects unsafe origins or renderer versions", () => {
    const input = ocrNotification();
    const result = renderResultNotification({ ...input, data: {
      ...input.data, matchDraftId: "a/b?x=#日本"
    } }, origin);
    expect(result.parts[0]?.content).toContain("/review/a%2Fb%3Fx%3D%23%E6%97%A5%E6%9C%AC>");
    for (const invalid of ["http://example.com", "https://user:pass@example.com", "https://example.com/path", "https://example.com/?secret=x"]) {
      expect(() => renderResultNotification(input, invalid)).toThrow("application origin");
    }
    expect(() => renderResultNotification(input, origin, 2)).toThrow("Unsupported notification renderer");
  });
});
