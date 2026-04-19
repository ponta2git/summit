---
applyTo: "src/time/**/*.ts"
---

# Time Review Rules

本 Bot は JST 基準で週次運用される。時刻計算のブレは仕様違反（締切誤判定・週キー破綻・順延期限ズレ）に直結する。本書は `src/time/**/*.ts` に適用する。

## Required patterns
- アプリは JST 基準で仕様判定を行う。Date 内部表現は UTC でも構わないが、**仕様上の判定基準・表示・ログ表示はすべて JST**（`Asia/Tokyo`）で解釈する。DST は考慮不要。
- 「現在時刻の取得」「週キー算出」「候補日計算」「順延期限（`POSTPONE_DEADLINE`）解釈」「締切日時計算」「リマインド予定時刻算出」は `src/time/` に集約する。他のコードから直接 `new Date()` / `Date.parse()` / 文字列連結で日付を作らない。
- ISO week 表記 `YYYY-Www` は `date-fns/getISOWeek` と `getISOWeekYear` を**併用**して算出する。`YYYY-Www` を自作しない。
- 金曜 Session（順延回数 0）と土曜 Session（順延回数 1）は**同一の週キーを共有する**。年跨ぎ（例: 12/31 金曜 → 1/1 土曜）で ISO year が変わるケースのテストを必須とする。
- `POSTPONE_DEADLINE="24:00"` は「候補日翌日 00:00 JST」としてのみ解釈する。`25:00` など 24 超え表記は受け付けず、parse 段階で弾く。
- 現在時刻は fake timer または関数 DI で差し替え可能にする。時刻依存ロジックをグローバル時計に直接結びつけない。

## Observed anti-patterns
- `new Date()` / `Date.parse()` を ad-hoc に各所で呼ぶ。
- `YYYY-Www` を `getISOWeek` だけで組み立てて ISO year を取り違える。
- `POSTPONE_DEADLINE` の `24:00` を「当日 24 時」と誤解釈し、JST 当日の 24:00（= 翌 00:00）とそれ以外の解釈を混在させる。
- タイムゾーン変換を各所で呼び、UTC と JST を混ぜる。

## Review checklist
- 週キー算出ロジックが年跨ぎ（ISO year 変化）でも壊れないか。
- 締切 21:30 / 自動送信 18:00 / 順延期限 24:00（= 翌 00:00 JST）の計算がすべて JST 固定で一致するか。
- 現在時刻に依存するロジックがテスト可能（fake timer / DI）な構造か。
- 時刻処理を呼び出す側が `src/time/` のエクスポートのみを使い、独自に `Date` を構築していないか。
