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

## Context
- ADR-0008 は送信専用フェーズの過渡期措置として、Session / Response を DB に持たず、module スコープ変数 `lastSentWeekKey` と in-memory Promise mutex で週次重複防止だけを行っていた。
- 本 PR で「出欠データを永続化し、メッセージに反映する」範囲の実装に着手する。具体的には、金曜自動送信 → 4 名の出欠ボタン押下記録 → 21:30 締切判定 → 欠席 or 未回答時の順延確認メッセージ投稿までを一貫して DB で扱う。
- この範囲では Session と Response の永続化が必須であり、ADR-0001 の「DB を正本とする」原則に回帰するタイミングと一致する。
- 開催決定メッセージ投稿・15 分前リマインド・順延ボタン本処理・`/cancel_week`・`/status` は本 PR のスコープ外で、後続 PR へ分割する。

## Decision
- `sessions` / `responses` テーブルを Drizzle schema に追加し、`pnpm db:generate` → レビュー → `pnpm db:migrate` で適用する。
  - `sessions(id pk, week_key, postpone_count, candidate_date, status, channel_id, ask_message_id, postpone_message_id, deadline_at, decided_start_at, cancel_reason, reminder_at, reminder_sent_at, created_at, updated_at)` に CHECK 制約と UNIQUE `(week_key, postpone_count)` を付与する。
  - `responses(id pk, session_id fk, member_id fk, choice, answered_at)` に UNIQUE `(session_id, member_id)` を付与し、ON CONFLICT UPDATE で最新回答に置き換える。
- 週次重複防止は UNIQUE 制約 + `ON CONFLICT DO NOTHING` で DB 側に寄せ、`lastSentWeekKey` を撤去する。`inFlightSends` は同一プロセス内の同時送信を直列化する Promise mutex として残す（DB チェック前の競合を吸収）。
- 出欠ボタン押下は `interaction.deferUpdate()` → cheap-first 検証 → `custom_id` zod parse → DB から Session 再取得 → transaction で Response upsert と status 条件付き遷移 → DB から組み立てた内容で `message.edit(...)` する。時刻選択で 4 名全員の時刻が揃えば `ASKING → DECIDED` に遷移する。
- 欠席押下 / 21:30 締切での未回答検出は共通 helper `settleAskingSession` で扱い、`ASKING → CANCELLED(reason)` → 募集メッセージ再描画 → 中止メッセージ投稿 → 順延確認メッセージ投稿 → `CANCELLED → POSTPONE_VOTING` 遷移 + `postpone_message_id` 保存 を原子的かつ冪等に行う（条件付き UPDATE を使い、複数経路から呼ばれても最初の 1 回だけが後続処理を実行する）。
- 金曜締切の cron tick を `createAskScheduler` に追加し、deadline を過ぎた `ASKING` Session を `settleAskingSession` に流す。cron 式は `src/config.ts` の `CRON_DEADLINE_SCHEDULE`（timezone `Asia/Tokyo`）。scheduler の戻り値は `{askTask, deadlineTask}` に拡張する。
- 起動時に `findNonTerminalSessions()` で非終端 Session を読み直し、deadline を経過している `ASKING` Session に `settleAskingSession` を走らせる（in-memory 状態を信頼しない）。
- 順延ボタン (`postpone:{sessionId}:{ok|ng}`) は custom_id 形式と zod 検証だけ ADR-0004 準拠で整え、押下処理は placeholder ephemeral 応答に留める（次 PR で実装）。
- ADR-0008 は `status: superseded`, `superseded-by: 9` とし、`docs/adr/README.md` Index を更新する。

## Consequences
- **DB が正本**に回帰し、再起動・同時押下・cron と interaction の競合下でも状態整合が保たれる。条件付き UPDATE + UNIQUE 制約で二重実行・二重書き込みが物理的に排除される。
- 新たに Neon (pooled) への接続が interaction 経路に加わる。`postgres(url, { prepare: false })` の明示が必須。
- 新 `CRON_DEADLINE_SCHEDULE`（`src/config.ts`）をデプロイ禁止窓（金 17:30〜土 01:00 JST）の **前** にマージ・デプロイする必要がある。PR 本文の運用影響欄で明示する。
- 起動時 recovery により、restart で ASKING Session を取りこぼさなくなる代わりに、起動直後に DB I/O が走る。DB 未起動時はアプリ起動に失敗する。
- ボタン押下で `message.edit` が失敗しても DB 状態は維持し、次 cron tick や次押下での再描画で自然に回復する（DB を巻き戻さない方針、ADR-0004 に準拠）。
- Operational implications:
  - ADR-0008 の受入リスク（再起動時の二重送信）は本 ADR で解消される。
  - 次 PR（開催決定メッセージ / 15 分前リマインド / 順延ボタン本処理）に向けたスキーマ（`reminder_at` / `reminder_sent_at` / `decided_start_at`）は本 PR で先行確保し、書き込みは次 PR 以降で行う。

## Alternatives considered
- **ADR-0008 を継続し in-memory のまま**: ボタン押下記録 / 締切判定 / 順延確認は DB 無しでは冪等化も再起動回復もできないため却下。
- **開催決定メッセージ・リマインドまで本 PR に含める**: レビュー粒度と PR サイズを抑えるため次 PR に分割。スキーマだけ先行確保することで schema 変更の頻度を下げる。
- **順延ボタン本処理も同 PR で実装**: スコープが広がり、順延ルールの最終仕様確定（§6 反復ルール）と並行するリスクが高いため却下。本 PR では custom_id 骨格と placeholder 応答までに留める。
- **drizzle-kit push で先行適用**: ADR-0003 の運用方針に反するため採らない。`generate` → レビュー → `migrate` に従う。
