---
adr: 0049
title: DB スキーマ・migration 管理を @momo/db に分離
status: accepted
date: 2026-04-29
supersedes: [0003]
superseded-by: null
tags: [db, ops, runtime]
---

# ADR-0049: DB スキーマ・migration 管理を @momo/db に分離

## TL;DR

momo-result との DB 共有に備え、スキーマ定義・migration・drizzle.config.ts を独立リポジトリ `ponta2git/momo-db` に移設した。summit は `"@momo/db": "file:../momo-db"` でパッケージ参照し、migration 実行は momo-db の責務とする。summit の fly.toml から `release_command` を削除し、本番 migration は deploy とは独立して momo-db から実行する。

## Context

summit の DB スタック選定と migration 運用は ADR-0003 で決定し、`src/db/schema.ts` / `drizzle/` / `drizzle.config.ts` を summit リポジトリ内に置いていた。

以下の変化が生じた:

- **momo-result との DB 共有**: 同じ Neon PostgreSQL インスタンスを参照する `momo-result` プロジェクトが登場し、スキーマ定義と migration を共同で管理する必要が生じた。
- **独立管理の要求**: summit のリリースサイクルと migration のタイミングが結合していると、momo-result 側が独立して DB 変更を計画・適用できない。
- **release_command の問題**: `fly.toml` の `release_command = "pnpm drizzle-kit migrate"` は summit deploy の前後に縛られており、DB 変更が summit 単体のリリースタイミングに依存してしまう。

## Decision

### リポジトリ分離

- `src/db/schema.ts` / `drizzle/` / `drizzle.config.ts` を新リポジトリ `ponta2git/momo-db` に移設。
- summit の `src/db/schema.ts` は `export * from "@momo/db";` の 1 行 re-export shim に変更（downstream の import パスは無変更）。
- summit の `package.json` に `"@momo/db": "file:../momo-db"` を追加（ローカル file: リンク）。
- `drizzle-kit` と `drizzle-zod` を summit の devDependencies から削除。

### migration の責務

- summit の `fly.toml` から `release_command` を削除する。
- 本番 migration は momo-db リポジトリで `pnpm db:migrate`（`DIRECT_URL` を設定して実行）。deploy 前に手動で適用するか、CI/CD を momo-db 側に別途構成する。
- ローカル開発では `compose.yaml` も momo-db に移設し、`db:up` / `db:down` / `db:migrate` は momo-db の責務。summit の `pnpm setup` が momo-db の各コマンドを呼び出す。

### CI 変更

- `static-baseline` と `integration-db` の全ジョブで `ponta2git/momo-db` を追加チェックアウトし、`GITHUB_WORKSPACE/momo-db/` に配置（summit から `../momo-db` で解決できる位置）。
- `integration-db` ジョブは momo-db から `pnpm db:migrate` を実行して統合 DB を準備する。

### Docker ビルド

- ビルドコンテキストを summit リポジトリ親ディレクトリに変更（`cd .. && fly deploy --config summit/fly.toml`）。
- Dockerfile を 4 ステージ構成に変更し、momo-db のビルド成果物（`dist/`）をランタイムイメージにコピーして symlink を解決する。

## Consequences

### 運用変化

- スキーマ変更は momo-db で行い（`db:generate` → SQL レビュー → `db:migrate`）、`pnpm build` で `dist/` を再生成後、summit で `pnpm install` + `pnpm typecheck` / `pnpm test` を実行して確認。
- 本番 migration は summit deploy とは独立したオペレーションになる（`release_command` によるゲートがなくなる）。migration を deploy 前に適用する運用規律を保つ必要がある。
- `pnpm db:check` は momo-db 側の検証項目になり、summit の検証シーケンス（typecheck → lint → test → build）には含まれない。

### Footguns

- **本番 migration 漏れ**: `release_command` がなくなったため、スキーマ変更を deploy したが migration を適用し忘れるリスクがある。スキーマ変更を伴う deploy は必ず momo-db から migration を先行適用すること。

## Alternatives considered

- **モノレポ（pnpm workspace）** — summit / momo-result が別リポジトリのため適合しない。
- **npm publish / private registry** — ローカル `file:` リンクで十分であり、publish 運用コストが不要。
- **summit に drizzle.config.ts を残し momo-result が参照** — 所有権があいまいになり、momo-result が独立して migration を管理できない。

## Re-evaluation triggers

- momo-result との DB 共有が不要になった場合、momo-db を summit 内に戻すことを検討。
- 参照プロジェクトがさらに増えた場合、npm publish（private registry）を検討。

## Links

- @see ADR-0003 (superseded by this ADR; stack 選定・ORM/concurrency ルールは有効)
