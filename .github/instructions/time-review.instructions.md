---
applyTo: "src/time/**/*.ts"
---

# Time Review Rules

JST 基準で週次運用される Bot の時刻計算。ブレは仕様違反（締切誤判定・週キー破綻・順延期限ズレ）に直結。DST は考慮不要。

## 必須ルール
- 仕様判定・表示・ログはすべて JST（`Asia/Tokyo`）で解釈する。Date 内部表現は UTC 可。
- 「現在時刻取得 / 週キー算出 / 候補日計算 / `POSTPONE_DEADLINE` 解釈 / 締切日時計算 / リマインド予定算出」は `src/time/` に集約。他コードから `new Date()` / `Date.parse()` / 文字列連結で日付を生成しない。
- ISO week `YYYY-Www` は `date-fns/getISOWeek` と `getISOWeekYear` を**併用**して算出する。自作禁止。
- 金曜 Session（`postponeCount=0`）と土曜 Session（`postponeCount=1`）は**同一週キーを共有**。年跨ぎ（12/31 金 → 1/1 土）で ISO year が変わるケースのテスト必須。
- `POSTPONE_DEADLINE="24:00"` は「候補日翌日 00:00 JST」のみ。`25:00` 等 24 超え表記は parse 段階で弾く。
- 現在時刻は fake timer / 関数 DI で差し替え可能に。時刻依存ロジックをグローバル時計に直接結ばない。
