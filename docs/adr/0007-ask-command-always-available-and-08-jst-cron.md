---
adr: 0007
title: /ask コマンドの常時実行許可と自動送信時刻 08:00 JST
status: accepted
date: 2026-04-20
supersedes: []
superseded-by: null
tags: [discord, ops, runtime, time]
---

# ADR-0007: `/ask` コマンドの常時実行許可と自動送信時刻 08:00 JST

## TL;DR
自動送信は毎週金曜朝（現行値は `src/config.ts` の `CRON_ASK_SCHEDULE`）、`/ask` は曜日・時刻ガードなしで常時実行可。重複は週キー単位で `sendAskMessage` 内に冪等化して防ぐ。

## Context
自動送信時刻変更と手動 `/ask` の実行ガード要否の決定。

Forces:
- `requirements/base.md` の自動投稿時刻（金曜 18:00 JST）を、運用者の起床前後に確認できる朝帯へ移したい要望が出た。
- 自動送信のみだとテスト投稿・障害復旧後の再送信・突発的なやり直し手段がなくなる。
- `/ask` に曜日・時刻ガードを入れると「当日まで打てない」「順延候補日との整合確認が必要」などロジックが二箇所に分散し複雑化する。
- 固定 4 名・非公開 Bot のため手動コマンド乱用リスクは極小で、手動経路の自由度確保のメリットが勝る。

## Decision

- 自動送信は毎週金曜朝に固定。cron 式・タイムゾーン・多重起動防止設定は `src/config.ts` の `CRON_ASK_SCHEDULE` を参照。
- `/ask` スラッシュコマンドは**曜日・時刻ガードを設けず常時実行可**。Interaction 検証（guild / channel / member）と週次重複防止（同一 ISO 週に 1 通）は常に適用する。
- 手動 `/ask` と cron 自動送信が同一週で重複しないよう、送信経路は共通の `sendAskMessage` に集約し**週キー単位で冪等化**する（cron と `/ask` のどちらが先でも 2 通目はスキップ）。
- 送信時点の「開催候補日」は `src/time/candidateDateForSend` の結果に従う。非金曜実行時の文言ルールは**仕様未確定**のため、確定までは現在日時をそのまま候補日として提示する（`// TODO(ai): spec clarification needed` 扱い）。
## Consequences

### Follow-up obligations
- 非金曜に `/ask` を実行した際の「開催候補日」文言仕様は未確定（`// TODO(ai): spec clarification needed`）。確定時点で本 ADR を更新するか後続 ADR を追加する。

### Operational invariants & footguns
- **Hard invariant**: 手動 `/ask` と cron 自動送信は共通の `sendAskMessage` に集約し、週キー単位で冪等化する（cron と `/ask` のどちらが先でも 2 通目はスキップ）。送信経路を分岐させると重複防止が崩れる。
- **Footgun**: `/ask` に曜日・時刻ガードを後から足さない（テスト投稿・障害リカバリ経路が塞がる）。検証は guild / channel / member と週次重複のみ。
- **Operational**: 朝の自動送信はデプロイ禁止窓（金 17:30〜土 01:00 JST）とは別枠で走る。cron 式・送信時刻の現在値は `src/config.ts` の `CRON_ASK_SCHEDULE` を参照（ADR-0022）。

## Alternatives considered

- **`/ask` に曜日・時刻ガードを設ける** — 運用者の手動リカバリ手段を塞ぎテスト・障害復旧で手詰まりになる。
- **自動送信時刻を 18:00 のまま維持** — 運用者の生活リズムに合わず朝に確認・調整したい要望を満たせない。
- **手動 `/ask` を別チャンネルで提供** — `env.DISCORD_CHANNEL_ID` 1 チャンネル運用の原則に反し設定・権限が複雑化する。
