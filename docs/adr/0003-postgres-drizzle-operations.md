---
adr: 0003
title: Postgres データストアと Drizzle マイグレーション運用
status: accepted
date: 2026-04-19
supersedes: []
superseded-by: null
tags: [db, runtime, ops]
---

# ADR-0003: Postgres データストアと Drizzle マイグレーション運用

## Context
本 Bot は固定 4 名・単一 Guild・単一チャンネル向けで、週 1 回の出欠募集を自動化する。
想定トラフィックは低く、平時の RPS は極小であるため、初期は無料枠で十分に運用できる。
一方で cron 実行と複数メンバーの同時ボタン押下が同時に発生し、同一 Session への更新競合は起きる。
このため、単純な read-modify-write ではなく、原子的な状態遷移と再試行前提の設計が必要になる。
Fly.io 上で単一インスタンス運用を維持しつつ、将来の戦績集計や運用監査に耐える履歴管理も必要である。
また、serverless PostgreSQL の接続形態では pooled 接続と direct 接続を用途別に分離しないと不整合や運用事故が起きやすい。
DDL の適用をアプリ起動に先行させ、失敗時に新バージョンを起動しない安全策も必要である。

## Decision
- データストアは **Neon PostgreSQL 16** を採用する。
  - 無料枠で当面の運用を賄える。
  - serverless 運用と branching が使え、変更検証の安全性を上げられる。
  - Fly 東京リージョンからのレイテンシが小さく、応答時間の予測が立てやすい。
- アプリ DB アクセスは **Drizzle ORM 0.45 + postgres.js** を採用する。
- アプリ接続は `DATABASE_URL`（Neon pooled / transaction pooling）を使い、クライアント生成時に `postgres(url, { prepare: false })` を必ず指定する。
- マイグレーション接続は `DIRECT_URL`（Neon direct / unpooled）を使う。
  - `DIRECT_URL` は `drizzle.config.ts` のみで参照する。
  - アプリ実行時 env には `DIRECT_URL` を含めない。
- 本番で **`drizzle-kit push` を禁止**し、以下のフローを固定する。
  1. `drizzle-kit generate` で `drizzle/` に SQL 差分を出力
  2. 差分 SQL をレビュー
  3. `drizzle-kit migrate` で適用（必要に応じて `drizzle-kit check` で整合性を検証）
- 本番 migration は Fly.io の `release_command = "pnpm drizzle-kit migrate"` で実行する。
  - migration が失敗したリリースは起動させない。
- 状態遷移は `db.transaction(...)` と条件付き `UPDATE ... WHERE status = ...` で原子的に扱う。
- `responses` テーブルは `(sessionId, memberId)` の unique 制約を持ち、二重投入を排除する。
  - 競合時は行を再取得し、DB 正本の内容でメッセージ再描画する。
- 動的 SQL は Drizzle のプレースホルダで構築し、`sql.raw()` にユーザー入力を渡さない。
  - 動的 `ORDER BY` や列名切替はホワイトリスト分岐で実装する。
- スキーマ定義と zod バリデーションは `drizzle-zod` で一元化し、型と検証ルールの乖離を防ぐ。

## Consequences
- Positive
  - 小規模運用に対してコスト効率が高く、運用開始の障壁が低い。
  - pooled / direct の役割分離で、ランタイム接続と DDL 適用の責務が明確になる。
  - `generate -> review -> migrate` により変更履歴とレビュー可能性が残る。
  - release_command で migration 失敗時の自動停止が効き、壊れたスキーマで起動しない。
  - transaction + 条件付き更新 + unique 制約により、同時押下と cron 競合での破壊的上書きを防げる。
  - drizzle-zod により DB スキーマと入力検証の同期が取りやすくなる。
- Negative
  - 接続 URL が 2 種類（`DATABASE_URL` / `DIRECT_URL`）になり、設定ミス余地が増える。
  - migration フローが `push` より手順的に重く、レビューの運用コストがかかる。
  - transaction 設計と競合ハンドリングの実装負荷が上がる。
  - ORM 層を使う分、単純 SQL 直書きより習熟コストが発生する。
- Operational implications
  - スキーマ変更時は必ず SQL 差分レビューを通す。
  - 本番障害時は「DB を正本」にして再描画・再試行で回復する。
  - 競合を前提に idempotent な更新条件を維持する。
  - **Integration テスト運用（P1 追加）**:
    - `tests/integration/**` は `INTEGRATION_DB=1` でのみ起動する。`vitest.config.ts` で除外し、専用の `vitest.integration.config.ts` + `describe.skipIf` による二重ゲートとする。
    - 接続先は localhost 系 (`localhost` / `127.0.0.1` / `::1` / `postgres`) に限定する。本番 `DATABASE_URL` を指していれば fail-fast で拒否する。本番誤爆防止の invariant。
    - テスト用接続は `src/db/client.ts` singleton を流用せず、ファイルスコープで `postgres(url, { prepare: false, max: 1 })` を個別に open/close する。
    - 並列 TRUNCATE による相互干渉を避けるため、`fileParallelism: false` で直列実行する（Vitest 4 で `poolOptions` は撤去）。
    - `members` は `beforeAll` で seed し、`beforeEach` では `responses` / `sessions` のみ `TRUNCATE ... CASCADE` する。
    - CI では `integration-db` job が Postgres 16 service を立て、`pnpm db:migrate` → `pnpm test:integration` を実行する。`.env.example` の port (5433) は GHA service の 5432 と異なるため、**job-level env で `DATABASE_URL` / `DIRECT_URL` を上書き**する（dotenv 優先順の罠回避）。

## Alternatives considered
- **Supabase Postgres**
  - 却下理由: 機能は豊富だが、本件では Auth など周辺機能を使わず、無料枠・branching・コスト面で Neon の方が適合した。
- **SQLite（Fly Volumes）**
  - 却下理由: 単一インスタンスでは成立するが、バックアップ運用・将来拡張・マイグレーション統制で PostgreSQL より不利。
- **pg（node-postgres）直叩き**
  - 却下理由: SQL 生書きの負担が増え、スキーマ型と zod 検証の連携を自前で維持するコストが高い。
- **Prisma**
  - 却下理由: discord.js 常駐プロセスに対して起動時間・生成物サイズ・migration 運用の癖が相対的に重く、Drizzle の方が軽量で扱いやすい。
- **`drizzle-kit push`**
  - 却下理由: 本番スキーマを直接更新し、履歴性・レビュー性・再現性が弱くなるため採用しない。
