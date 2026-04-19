---
applyTo: "src/time/**/*.ts"
---

# Time Review Rules

## Required patterns
- JST 固定（`Asia/Tokyo`）前提で時刻処理を実装する。
- ISO week は `date-fns/getISOWeek` と `getISOWeekYear` を併用する。
- `POSTPONE_DEADLINE=24:00` は候補日翌日 00:00 JST としてのみ解釈する。
- `25:00` など 24 超え表記を受け入れない。
- 年跨ぎケース（ISO year 変化）を考慮し、テストで保証する。
- fake timer や DI で現在時刻を差し替え可能にする。

## Observed anti-patterns
- `new Date()` / `Date.parse()` を ad-hoc に各所で呼ぶ。
- `YYYY-Www` を手組みして ISO year を取り違える。
- `POSTPONE_DEADLINE` の解釈を文字列演算に依存させる。

## Review checklist
- 週キー算出ロジックが年跨ぎで壊れないか。
- 締切計算が JST と 24:00 仕様に一致しているか。
- 現在時刻依存ロジックがテスト可能な構造か。

## 参照
- `requirements/base.md` §3, §4, §6, §10, §14
- `.github/instructions/runtime.instructions.md`
- `AGENTS.md`
