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

## TL;DR
DB は Neon PostgreSQL 16、アプリは Drizzle ORM + postgres.js。アプリは pooled `DATABASE_URL`（`prepare: false` 必須）、migration は direct `DIRECT_URL`（`drizzle.config.ts` 専用）を使う。本番の `drizzle-kit push` は禁止、`generate → review → migrate` を Fly の `release_command` で強制する。

## Context
永続化スタックと migration 運用の決定。

Forces:
- 低トラフィックだが、cron tick と複数メンバー同時ボタン押下で同一 Session への更新競合が起きる。素の read-modify-write では不整合になる。
- 将来の戦績集計・監査に耐える履歴管理が要る（SQLite + Volume では運用負担が増える）。
- Serverless PostgreSQL では pooled 接続と direct 接続を用途別に分離しないと、prepared statement キャッシュ衝突や migration 経路混同で運用事故が起きる。
- DDL 適用がアプリ起動より後になると、失敗した migration が新バージョンで走り続けてしまう。起動前に止める仕組みが必要。
- 本番での `drizzle-kit push` は履歴性・レビュー性を失い、個人開発でも schema drift の温床になる。

## Decision

### Stack
- **Neon PostgreSQL 16** + **Drizzle ORM 0.45 + postgres.js**。スキーマと zod は `drizzle-zod` で一元化する。

### Connection separation
- アプリ接続: `DATABASE_URL`（Neon pooled / transaction pooling）。クライアント生成時に `postgres(url, { prepare: false })` を**必ず**指定する（pooler 互換）。
- Migration 接続: `DIRECT_URL`（Neon direct / unpooled）。`drizzle.config.ts` **のみ**で参照し、アプリ実行時 env には含めない。

### Migration flow
- 本番での `drizzle-kit push` は**禁止**。固定フロー: `drizzle-kit generate` → `drizzle/` 差分 SQL レビュー → `drizzle-kit migrate`（必要に応じ `drizzle-kit check` で履歴整合性検証）。
- 本番 migration は Fly の `release_command = "pnpm drizzle-kit migrate"` で実行する。migration 失敗リリースは起動させない。

### Concurrency
- 状態遷移は `db.transaction(...)` + 条件付き `UPDATE ... WHERE status = ...` で原子的に扱う（read-modify-write 裸書き禁止）。
- `responses` は `(sessionId, memberId)` **UNIQUE** で二重投入を排除。競合時は行を再取得して DB 正本から再描画する。
- 動的 SQL は Drizzle プレースホルダで組む。`sql.raw()` にユーザー入力を渡さない。動的 `ORDER BY` / 列名切替は**ホワイトリスト分岐**で実装する。

### Integration tests (P1)
- `tests/integration/**` は `INTEGRATION_DB=1` のみで起動。`vitest.config.ts` で除外 + 専用 `vitest.integration.config.ts` + `describe.skipIf` の**二重ゲート**。
- 接続先は localhost 系（`localhost` / `127.0.0.1` / `::1` / `postgres`）に限定。本番 `DATABASE_URL` を指していれば fail-fast で拒否する（本番誤爆防止の invariant）。
- `src/db/client.ts` singleton は流用せず、ファイルスコープで `postgres(url, { prepare: false, max: 1 })` を個別に open/close する。
- `fileParallelism: false` で直列実行（並列 TRUNCATE 干渉回避。Vitest 4 で `poolOptions` は撤去）。
- `members` は `beforeAll` で seed、`beforeEach` は `responses` / `sessions` のみ `TRUNCATE ... CASCADE`。
- CI では `integration-db` job が Postgres 16 service を立て、`pnpm db:migrate` → `pnpm test:integration` を実行。`.env.example` の port (5433) と GHA service の 5432 が異なるため **job-level env で `DATABASE_URL` / `DIRECT_URL` を上書き**する（dotenv 優先順の罠回避）。

## Consequences

### Follow-up obligations
- スキーマ変更は `pnpm db:generate` → `drizzle/` SQL 差分レビュー → `pnpm db:migrate` → `pnpm db:check` の順で進める。
- 本番 migration は Fly `release_command = "pnpm drizzle-kit migrate"` で実行し、失敗リリースが起動しないことを保つ。

### Operational invariants & footguns
- **Hard invariant**: アプリクライアントは `postgres(url, { prepare: false })` を明示する（Neon pooler / PgBouncer 互換）。抜けると prepared statement キャッシュ衝突で間欠障害になる。
- **Hard invariant**: `DIRECT_URL` は `drizzle.config.ts` 専用。アプリ実行時 env に含めない（pooled/direct 混用事故防止）。
- **Hard invariant**: 本番で `drizzle-kit push` 禁止。履歴性・レビュー性が壊れる。`generate → review → migrate` のみ。
- **Footgun**: 状態遷移は `db.transaction(...)` + 条件付き `UPDATE ... WHERE status = ...` で書く。read-modify-write 裸書きは同時押下 / cron 競合で上書き事故を起こす。
- **Footgun**: `sql.raw()` にユーザー入力を渡さない。動的 `ORDER BY` / 列名切替はホワイトリスト分岐で実装する。
- **Footgun**: `responses` の二重投入は `(sessionId, memberId)` UNIQUE で排除。競合時は DB から行を再取得して正本から再描画する（アプリ層で重複判定を書き直さない）。
- **Integration tests (P1)**:
  - `tests/integration/**` は `INTEGRATION_DB=1` でのみ起動。`vitest.config.ts` での除外 + 専用 `vitest.integration.config.ts` + `describe.skipIf` の**二重ゲート**を崩さない。
  - 接続先は localhost 系（`localhost` / `127.0.0.1` / `::1` / `postgres`）限定。本番 `DATABASE_URL` を指していれば fail-fast で reject する invariant を外さない（本番誤爆防止）。
  - `src/db/client.ts` singleton を流用せず、ファイルスコープで `postgres(url, { prepare: false, max: 1 })` を個別に open/close する。
  - `fileParallelism: false` で直列実行する（並列 TRUNCATE 干渉回避。Vitest 4 で `poolOptions` は撤去済みで等価な代替はない）。
  - `members` は `beforeAll` で seed、`beforeEach` は `responses` / `sessions` のみ `TRUNCATE ... CASCADE`。
  - CI では `integration-db` job が Postgres 16 service を立て、`pnpm db:migrate` → `pnpm test:integration`。`.env.example` の port (5433) と GHA service の 5432 が異なるため **job-level env で `DATABASE_URL` / `DIRECT_URL` を上書き**する（dotenv 優先順の罠で上書きが効かないと本番 URL に fallback しうる）。

## Alternatives considered

- **Supabase Postgres** — Auth 等の周辺機能を使わず、無料枠・branching・コストで Neon が適合する。
- **SQLite（Fly Volumes）** — バックアップ運用・将来拡張・migration 統制で PostgreSQL より不利。
- **pg（node-postgres）直叩き** — SQL 生書き負担とスキーマ型/zod 連携の自前維持コストが高い。
- **Prisma** — 常駐プロセスに対し起動時間・生成物サイズ・migration 運用の癖が相対的に重い。
- **`drizzle-kit push`** — 本番スキーマを直接更新し履歴性・レビュー性・再現性が弱くなる。
