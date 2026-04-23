---
adr: 0002
title: JST 固定と時刻処理の集約
status: accepted
date: 2026-04-19
supersedes: []
superseded-by: null
tags: [time, runtime]
---

# ADR-0002: JST 固定と時刻処理の集約

## TL;DR
起動時に `TZ=Asia/Tokyo` を固定し、現在時刻・週キー・候補日・締切・順延期限の算出はすべて `src/time/` に集約する。週キーは `date-fns/getISOWeek` + `getISOWeekYear` 併用、`POSTPONE_DEADLINE="24:00"` は「翌日 00:00 JST」のみと定義する。

## Context
時刻計算の基準と集約先の決定。仕様は日本語で JST 表現（「金曜 18:00 / 21:30 / 本日 24:00」）で記述される。

Forces:
- 日本国内 1 Guild 固定運用。DST は考慮不要で、TZ 柔軟性より「どこで判定しても同じ結果」の単純さが優先。
- Date 内部表現が UTC でも、判定・表示・運用ログが JST 以外だと仕様解釈が利用者認識と乖離する。
- 年跨ぎ週（例 12/31 金 → 1/1 土）で暦年と ISO week year がズレ、自作週キーは二重 Session / 誤集計の温床。
- `"24:00"` は日本語では自然だが一般パーサは当日 24 時 / 翌日 00 時で曖昧になり、`25:00` 等の拡張を許すと境界が崩れる。
- 年跨ぎ・締切直前・順延期限切れを安定テストするため、時刻依存ロジックをグローバル時計に直結させない。

## Decision

### Invariants
- **JST 固定**。起動時 `process.env.TZ = "Asia/Tokyo"` を設定。判定・表示・ログはすべて JST 基準に正規化する（Date 内部表現は UTC 可）。
- DST は**考慮しない**（日本国内運用限定）。
- 現在時刻は fake timers / DI で差し替え可能にする。時刻依存ロジックをグローバル時計に直結させない。

### 集約
- 現在時刻取得・週キー算出・候補日計算・締切計算・リマインド予定算出・`POSTPONE_DEADLINE` 解釈は `src/time/` に**集約**する。
- `src/time/` 以外での `new Date()` / `Date.parse()` / 日付文字列手組みによる仕様判定は**禁止**。

### 週キー
- `date-fns/getISOWeek` と `getISOWeekYear` を**併用**して算出する（暦年ベースで `YYYY-Www` を自作しない）。
- 金曜 Session（順延 0）と土曜 Session（順延 1）は**同一週キーを共有**する（年跨ぎで ISO year がズレるケース含む）。

### `POSTPONE_DEADLINE`
- `"24:00"` は「候補日翌日 00:00 JST」**のみ**として解釈する。`25:00` 等の 24 超え表記は parse 段階で**拒否**する。

## Consequences

### Operational invariants & footguns
- **Hard invariant**: 金曜 Session（`postponeCount=0`）と土曜 Session（`postponeCount=1`）は同一 `weekKey` を共有する（年跨ぎで ISO year がズレるケースを含む）。
- **Footgun**: `src/time/` 以外で `new Date()` / `Date.parse()` / 日付文字列手組みを仕様判定に使わない。JST 一貫性と fake timers / DI での差し替え可能性が壊れる。
- **Footgun**: 週キーは `date-fns/getISOWeek` と `getISOWeekYear` を**両方**使う。暦年 + 週番号で自作すると年跨ぎ（12/31 金 → 1/1 土）で ISO year がずれ二重 Session を生む。
- **Footgun**: `POSTPONE_DEADLINE="24:00"` は「候補日翌日 00:00 JST」のみ。`25:00` 等の 24 超え表記は parse 段階で reject する（当日終端として緩く解釈しない）。
- **Footgun**: 時刻依存ロジックをグローバル時計に直結させない。現在時刻は `src/time/` 経由で取得し、fake timers / DI で差し替え可能に保つ。

## Alternatives considered

- **UTC 保持 + 表示時だけ JST 変換** — 締切・順延判定まで UTC 発想で書くことになり業務時刻の読替えミスを誘発する。
- **複数 IANA タイムゾーン対応** — 利用者・運用 Guild が日本国内固定であり用途に対して過剰。
- **`Intl.DateTimeFormat` で週キーを組み立てる** — ISO week / ISO week year を安全に扱いづらく年跨ぎ実装が複雑化する。
- **`24:00` を当日終端として緩く扱う** — 翌日 00:00 境界が曖昧になり `25:00` 等の拡張表記もぶれる。
