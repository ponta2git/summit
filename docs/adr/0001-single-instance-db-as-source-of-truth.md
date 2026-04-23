---
adr: 0001
title: 単一インスタンス常駐運用と DB を正本とする状態管理
status: accepted
date: 2026-04-19
supersedes: []
superseded-by: null
tags: [runtime, ops, db]
---

# ADR-0001: 単一インスタンス常駐運用と DB を正本とする状態管理

## TL;DR
Fly.io の単一インスタンス常駐で運用し、週次 Session の正本は常に Neon PostgreSQL。Discord 表示や in-memory 状態は正本にせず、再描画は DB から組み直す。状態遷移は許可遷移を型で閉じた edge-specific API と条件付き UPDATE で冪等に行う。

## Context
週 1 回の時刻駆動処理（募集送信・締切判定・順延確認。スケジュールは `src/config.ts`、ADR-0022）をどこに正本を置いて実現するかの決定。

Forces:
- 個人開発・固定 4 名規模で、高可用性より壊れにくさ・理解しやすさを優先する。
- Discord 表示は `message.edit` 失敗や API 一時障害で乖離しうるため正本にできない。
- 再起動・デプロイ・Discord API 失敗・同一処理の再実行でも週次 Session 状態が破損してはならない。
- `node-cron` の多重登録や in-memory 状態への依存は、同一週の募集・締切判定を二重実行させる温床。

## Decision

### Runtime topology
- Fly.io 単一インスタンス常駐（`min_machines_running=1`、`auto_stop_machines` 無効、rolling deploy）。scale-out / scale-to-zero / 外部 cron 起動型は**禁止**。
- `node-cron` の登録はプロセス起動中に 1 回のみ。重複登録はバグ扱い。設定値は `src/config.ts` を参照。

### Source of truth
- **永続状態の唯一の正本は Neon PostgreSQL**。in-memory はキャッシュ/補助情報に限定し、正しさの根拠にしない。
- Discord の `message.edit` / 投稿失敗で DB を**巻き戻さない**。表示再同期は次 tick または次 interaction で再試行する。

### Startup recovery
- 起動時に非終端 Session を DB から再読込し、募集・締切・順延・リマインドの未完了タスクを復元する。

### State transitions
- cron は**毎 tick DB を再読込**して再計算する（**at-least-once** 前提、**同一 tick の重複実行で結果が変わらない冪等性**を保証）。
- Session の状態遷移は **edge-specific API** のみ公開（`cancelAsking` / `startPostponeVoting` / `completePostponeVoting` / `decideAsking` / `completeCancelledSession` / `completeSession`）。任意 from/to を取る `transitionStatus` 風 API は**採用しない**——許可遷移グラフを型で閉じるため。
- 許可遷移の正本は `src/db/ports.ts` の `SESSION_ALLOWED_TRANSITIONS`。repository は各 edge で `UPDATE ... WHERE status = <expected_from>` を 1 段の **CAS** として実行する。

## Consequences

### Follow-up obligations
- 非終端 Session（`COMPLETED` / `SKIPPED` 以外）を列挙できる DB スキーマとクエリを維持する（起動時 recovery の前提）。

### Operational invariants & footguns
- **Hard invariant**: Fly は `min_machines_running=1` 固定。scale-out / scale-to-zero / 外部 cron 起動型へ切り替えない。分散ロックやリーダー選出を前提にした実装を混ぜ込まない。
- **Hard invariant**: `node-cron` 登録はプロセス起動中 1 回のみ。hot reload / 動的再登録で多重化しやすい。
- **Footgun**: `message.edit` / Discord API 失敗で DB を巻き戻さない。表示再同期は次 tick または次 interaction に任せる（DB が正本。応急修正で表示側に合わせると整合が壊れる）。
- **Footgun**: 任意 from/to を取る `transitionStatus` 風 API を追加しない。許可遷移グラフが型で閉じなくなる。新状態は edge-specific API を追加する（正本は `src/db/ports.ts` の `SESSION_ALLOWED_TRANSITIONS`）。
- **Footgun**: cron は at-least-once 前提。同一 tick の重複実行で結果が変わらない冪等性を崩さない（状態判定 + 条件付き `UPDATE ... WHERE status = ...` を省略しない）。
- **Monitoring**: プロセス生存だけでなく cron tick の継続を監視する（healthchecks.io ping 停止で検知）。

## Alternatives considered

- **複数インスタンス + 分散ロック** — 固定 4 名・週 1 回の規模に対しロック/重複実行/障害時解放の複雑さが過剰。
- **Cloudflare Workers 等 Cron Triggers 型** — discord.js の常時稼働前提と相性が悪く、DB 中心の状態復元も複雑化する。
- **GitHub Actions schedule cron** — 実行時刻の揺らぎ・キュー待ち・再試行制御が締切判定に不向き。
- **in-memory 状態を主とし起動時だけ DB ロード** — 再起動直前・Discord 表示差分・二重起動で正本が複数化し整合性が破綻する。
