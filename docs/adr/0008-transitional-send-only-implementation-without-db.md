---
adr: 0008
title: 送信専用フェーズにおける DB 未使用実装と in-memory 重複防止（過渡期）
status: superseded
date: 2026-04-20
supersedes: []
superseded-by: 9
tags: [runtime, db, ops]
---

# ADR-0008: 送信専用フェーズにおける DB 未使用実装と in-memory 重複防止（過渡期）

## TL;DR
**Superseded by ADR-0009.** 送信専用フェーズに限り DB 未使用・in-memory 週キーで重複防止した過渡期判断。ADR-0001 の「DB 正本」原則との一時的妥協で、回答記録実装開始時に ADR-0009 へ移行済み。

## Context
送信専用フェーズで ADR-0001「DB 正本」原則と一時的に衝突する妥協判断。

Forces:
- 最小実装は「ボタン付き募集メッセージの投稿」だけを切り出し、押下記録・集計・締切・順延判定は後続フェーズに分離する方針になった。
- この段階で Session / Response の schema を先行実装すると、ボタン本実装時の仕様再考で migration やり直しコストが大きい。
- 一方で cron 自動送信と `/ask` 手動送信が同一週に二重投稿する事故は避けなければならない。
- 結果として、DB 永続化を保留しつつ in-memory 週キーで重複防止する案が必要になり、ADR-0001（in-memory を信頼しない）との一時的衝突を過渡期決定として明示記録する必要が生じた。

## Decision

**Superseded by ADR-0009。** 以下は過渡期の決定。具体実装は ADR-0009 への移行時に撤去済み。

- 送信専用フェーズでは **Session / Response テーブルを作らず、DB 書き込みを伴う状態更新も行わない**。
- 週次重複防止は `src/discord/askMessage.ts` の module スコープ変数 `lastSentWeekKey` と同時実行ガードの `inFlightSend` Promise mutex で実装。
  - 同一 ISO 週キー（`src/time/isoWeekKey`）への 2 通目は `{ status: "skipped" }` を返す。
  - 同時発火（cron と `/ask` 等）は in-flight Promise を共有し、後続呼び出しは先行結果を待機後にスキップする。
- ボタン押下は当面 ephemeral の placeholder 応答のみ。DB 記録も message 再描画も行わない。
- **受入リスク**: Bot 再起動で `lastSentWeekKey` が失われ同一週に再送信される可能性。デプロイ禁止窓の遵守と運用者目視で運用カバーする。
- **過渡期限定**。回答記録・集計・再描画・順延のいずれかを実装するフェーズに入る時点で ADR-0001 準拠の DB 永続化へ移行する（→ ADR-0009 で移行済み）。
## Consequences

### Operational invariants & footguns
- **Historical**: ADR-0009 で `lastSentWeekKey` / `inFlightSend` の module スコープ状態と `__resetSendStateForTest` は撤去済み。過渡期の受入リスク（再起動で in-memory 状態が消え同一週に再送信される可能性）は ADR-0009 の UNIQUE `(week_key, postpone_count)` + `ON CONFLICT DO NOTHING` で解消。
- **Footgun**: 新規コードに in-memory 週キー dedup パターンを持ち込まない（ADR-0001「DB を正本 / in-memory を信頼しない」原則に反する）。重複防止は DB 側 UNIQUE 制約に寄せる。

## Alternatives considered

- **最初から Session / Response テーブルで DB 永続化** — ボタン仕様確定前に schema 固定すると migration やり直しと運用ポリシー上のコストが大きい。
- **重複防止を行わず毎回送信する** — cron と `/ask` の同時発火・再実行で二重投稿が起きやすく運用事故になる。
- **重複防止キーをファイル / Redis 等に退避** — 最終的には DB 統合予定で暫定依存を追加する費用対効果が低い。
