---
adr: 0009
title: Session / Response を DB に永続化し順延確認メッセージ投稿までを実装
status: accepted
date: 2026-04-21
supersedes: [8]
superseded-by: null
tags: [runtime, db, discord, ops]
---

# ADR-0009: Session / Response を DB に永続化し順延確認メッセージ投稿までを実装

## TL;DR
ADR-0008 を supersede。`sessions` / `responses` テーブルを Drizzle で追加し、自動送信 → 4 名ボタン押下 → 締切判定 → 順延確認メッセージ投稿までを DB 正本で実装する。週次重複防止は UNIQUE 制約と `ON CONFLICT DO NOTHING` で DB 側に寄せる。

## Context
ADR-0008 の過渡期措置から ADR-0001「DB 正本」原則へ回帰する PR 単位の決定。

Forces:
- ADR-0008 は送信専用フェーズの暫定として `lastSentWeekKey` と in-memory Promise mutex のみで重複防止していた。回答記録・締切判定・順延を実装する段階では冪等化も再起動回復も不可能。
- 本 PR のスコープは「金曜自動送信 → 4 名ボタン押下記録 → 締切判定 → 欠席/未回答時の順延確認メッセージ投稿」までの一貫した DB 正本化。
- 開催決定メッセージ投稿・15 分前リマインド・順延ボタン本処理・`/cancel_week`・`/status` はレビュー粒度と PR サイズ抑制のためスコープ外とし、後続 PR に分割する（関連列は先行確保）。

## Decision

### Scope
本 PR で実装する範囲: 金曜自動送信 → 4 名の出欠ボタン押下記録 → 締切判定 → 欠席/未回答時の順延確認メッセージ投稿まで。**スコープ外（後続 PR）**: 開催決定メッセージ投稿・15 分前リマインド・順延ボタン本処理・`/cancel_week`・`/status`。

### Schema（Drizzle + `pnpm db:generate` → レビュー → `pnpm db:migrate`）
- `sessions(id pk, week_key, postpone_count, candidate_date, status, channel_id, ask_message_id, postpone_message_id, deadline_at, decided_start_at, cancel_reason, reminder_at, reminder_sent_at, created_at, updated_at)` に CHECK 制約 + **UNIQUE `(week_key, postpone_count)`**。
- `responses(id pk, session_id fk, member_id fk, choice, answered_at)` に **UNIQUE `(session_id, member_id)`**。`ON CONFLICT ... DO UPDATE` で最新回答に置き換える。
- `reminder_at` / `reminder_sent_at` / `decided_start_at` は本 PR で列を**先行確保**するが、書き込みは次 PR 以降（スキーマ先行）。

### Dedup invariant
- 週次重複防止は UNIQUE 制約 + `ON CONFLICT DO NOTHING` で **DB 側に寄せ**、ADR-0008 の `lastSentWeekKey` は**撤去**する。
- `inFlightSends` は同一プロセス内の同時送信を直列化する Promise mutex として**残す**（DB チェック前の競合吸収用）。

### Button flow
1. `interaction.deferUpdate()`
2. cheap-first 検証 → `custom_id` zod parse
3. DB から Session 再取得
4. **transaction 内で** Response upsert + status 条件付き遷移
5. DB から組み立てた内容で `message.edit(...)`

4 名全員の時刻が揃えば `ASKING → DECIDED` に遷移。

### Settlement（共通 helper `settleAskingSession`）
欠席押下 / 締切での未回答検出を統一扱い。**原子的かつ冪等**に次を実行: `ASKING → CANCELLED(reason)` → 募集メッセージ再描画 → 中止メッセージ投稿 → 順延確認メッセージ投稿 → `CANCELLED → POSTPONE_VOTING` 遷移 + `postpone_message_id` 保存。**条件付き UPDATE** により複数経路から呼ばれても最初の 1 回だけが後続処理を実行する。

### Scheduler
- 締切 cron tick を `createAskScheduler` に追加し、deadline を過ぎた `ASKING` Session を `settleAskingSession` に流す。cron 式は `src/config.ts` の `CRON_DEADLINE_SCHEDULE` を参照。scheduler 戻り値は `{askTask, deadlineTask}` に拡張。

### Startup recovery
- `findNonTerminalSessions()` で非終端 Session を読み直し、deadline 経過済み `ASKING` に `settleAskingSession` を走らせる（in-memory 状態は信頼しない、ADR-0001 準拠）。

### 順延ボタン (`postpone:{sessionId}:{ok|ng}`)
- custom_id 形式と zod 検証のみ ADR-0004 準拠で整備。押下処理は placeholder ephemeral に留める（次 PR で本実装）。

### ADR bookkeeping
- ADR-0008 を `status: superseded`, `superseded-by: 9` とし、`docs/adr/README.md` Index を更新する。
## Consequences

### Follow-up obligations
- 先行確保した列 `reminder_at` / `reminder_sent_at` / `decided_start_at` の書き込み・利用を後続 PR で実装する。
- スコープ外（開催決定メッセージ投稿 / 15 分前リマインド / 順延ボタン本処理 / `/cancel_week` / `/status`）を後続 PR で追加する。
- `CRON_DEADLINE_SCHEDULE` 追加はデプロイ禁止窓（金 17:30〜土 01:00 JST）の**前**にマージ・デプロイする（PR 本文の運用影響欄で明示する運用を維持）。

### Operational invariants & footguns
- **Hard invariant**: 週次重複防止は DB 側（UNIQUE `(week_key, postpone_count)` + `ON CONFLICT DO NOTHING`）に寄せる。ADR-0008 の `lastSentWeekKey` 等アプリ層の週キー記録を復活させない。
- **Hard invariant**: `inFlightSends` Promise mutex は DB チェック前の同一プロセス内同時送信を吸収するために**残す**。削除すると同一 tick の並行送信が UNIQUE 違反まで到達して無駄なエラーになる。
- **Hard invariant**: `settleAskingSession` は欠席押下と締切未回答の双方から呼ばれる。条件付き UPDATE による CAS で「最初の 1 回だけが後続処理を実行する」冪等性を崩さない（再描画 → 中止メッセージ → 順延確認メッセージ → `CANCELLED → POSTPONE_VOTING` の順序と原子性を分割しない）。
- **Hard invariant**: ボタン押下経路は Response upsert（`ON CONFLICT ... DO UPDATE` で最新回答に置換）と status 条件付き遷移を**同一 transaction**にまとめる。分離すると 4 人目の同時押下で `ASKING → DECIDED` 遷移を取り逃す。
- **Footgun**: 起動時 recovery（`findNonTerminalSessions`）で deadline 経過済み `ASKING` を拾えるよう、非終端列挙クエリ・`status` インデックス・CHECK 制約を緩めない。取りこぼすと再起動後に宙づりになる。
- **Footgun**: 順延ボタン（`postpone:{sessionId}:{ok|ng}`）は現状 placeholder ephemeral のみ。本処理実装前に `POSTPONE_VOTING` からの遷移を勝手に走らせない（custom_id と zod 検証のみ先行整備、ADR-0004 準拠）。
- **Footgun**: `message.edit` 失敗で DB を巻き戻さない。次 cron tick / 次押下での再描画で収束させる（ADR-0004 準拠）。

## Alternatives considered

- **ADR-0008 を継続し in-memory のまま** — ボタン押下記録・締切判定・順延確認は DB 無しでは冪等化も再起動回復もできない。
- **開催決定メッセージ・リマインドまで本 PR に含める** — レビュー粒度と PR サイズ抑制のため次 PR に分割し schema だけ先行確保する。
- **順延ボタン本処理も同 PR で実装** — スコープが広がり §6 反復ルール確定と並行するリスクが高い。
- **drizzle-kit push で先行適用** — ADR-0003 の運用方針に反するため `generate` → レビュー → `migrate` に従う。
