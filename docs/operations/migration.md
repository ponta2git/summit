# Migration Operations

drizzle-kit を用いた schema migration の生成・適用・ロールバック手順。

> **重要**: schema 定義・migration ファイル・drizzle.config.ts は `../momo-db` リポジトリで管理する。
> summit の `src/db/schema.ts` は `momo-db` の re-export shim になった。

設計正本: `docs/db-rule.md`。schema と migration 履歴の正本は `../momo-db`。

## 原則 (常時ルール再掲)

- migration は `drizzle-kit generate` + `drizzle-kit migrate` のみ。**`drizzle-kit push` は禁止**。設計契約は `docs/db-rule.md` を参照する。
- `DIRECT_URL` は momo-db の `drizzle.config.ts` 専用 (アプリ code から参照禁止)。
- 金 17:30〜土 01:00 JST は migration 禁止 (AGENTS.md deploy 禁止窓)。
- `momo-db` CI の `db:check` ジョブで migration 履歴の整合性を自動検出する。

## 新規 migration の作り方

```bash
# 1. ../momo-db/src/schema.ts を編集
vim ../momo-db/src/schema.ts

# 2. SQL を生成 (momo-db/drizzle/ に出力)
cd ../momo-db
pnpm db:generate

# 3. 生成 SQL をレビュー
git diff drizzle/

# 4. ローカル DB で適用テスト (momo-db の .env.local に DIRECT_URL が必要)
pnpm db:migrate

# 5. momo-db を再ビルド (summit が dist/ を参照するため)
pnpm build

# 6. summit 側で typecheck / lint / test / build
cd ../summit
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

生成された SQL ファイルと `momo-db/drizzle/meta/` の両方を `momo-db` リポジトリに commit する。

### Fail-closed preflight を持つ migration

Session aggregate / ordered outbox migration は、重複 dedupe key と未対応 outbox kind を検出すると transaction を中断する。旧 reminder claim marker は監査値を保持したまま migration を通し、アプリ側の outbox recovery で再配送する。

- dedupe key / outbox kind の guard を削除・迂回して再実行しない。
- 対象行を read-only query で特定し、backup を確認する。
- 解消方法を別 migration としてレビューし、`generate` + `migrate` の手順を守る。
- preflight 失敗時は application deploy を進めない。

## 本番への適用

> **注意**: Fly.toml の `release_command` は削除済み。migration は summit deploy とは独立して手動で適用する。

```bash
# 本番の DIRECT_URL (Neon unpooled) で実行
DIRECT_URL=<本番 unpooled URL> pnpm db:migrate
# ↑ momo-db ディレクトリで実行
```

または momo-db の `.env.local` に本番 DIRECT_URL を設定してから:
```bash
cd ../momo-db
pnpm db:migrate  # momo-db の .env.local から DIRECT_URL を読む
```

**禁止**: `fly ssh` 経由で生 SQL (`DROP` / `TRUNCATE` / 手動 `UPDATE`) を流すこと (`AGENTS.md` §2)。

## ローカル開発 (setup 経由)

`summit` の `setup` スクリプトがプロジェクト全体を一括セットアップする:

```bash
# summit ディレクトリで
pnpm setup
# = momo-db install+build+db:up+db:migrate → summit install → db:seed
```

postgres コンテナ（`compose.yaml`）は momo-db で管理する。`db:up`/`db:down` は momo-db で実行。

## ロールバック

drizzle-kit は **down migration を自動生成しない**。ロールバックが必要なケースは以下のいずれかで対応:

### A. 新 migration を前に進める形で打ち消す (推奨)

破壊的変更 (列削除 / 型変更) を「足して戻す」新 migration を書く。例: `DROP COLUMN foo` を戻すなら `ALTER TABLE t ADD COLUMN foo ...`。

手順:

1. `../momo-db/src/schema.ts` を直前版に戻す (git revert 相当)
2. `pnpm db:generate` で打ち消し migration を生成 (momo-db で)
3. `pnpm db:migrate` (momo-db で)
4. `pnpm build` (momo-db で) → summit deploy

### B. Neon PITR で時点復元 (B は A が困難な場合のみ)

データ欠損を伴う migration を戻したいなら、schema の roll-back と併せて PITR で復元する ([backup.md](./backup.md) §restore-pitr)。

## migration 失敗時の復旧 (復旧不能ケース D)

**症状**: `pnpm db:migrate` が途中で失敗し、`__drizzle_migrations` テーブルと schema 実体がずれる。

**SOP**:

1. **焦らない**。application deploy を止め、失敗した migration をその場で再実行しない
2. Neon dashboard の read-only inspection で schema 実体と `__drizzle_migrations` の状態を確認する
3. transaction が rollback 済みなら、momo-db で migration を修正し、local DB と CI で再検証してから通常手順で適用する
4. 部分適用や data loss が疑われる場合は、手動 SQL や `__drizzle_migrations` への手 INSERT を行わず、[backup.md](./backup.md) の PITR で新 branch へ復元する。前進修復が必要なら、momo-db の review 済み追加 migration として作成する
5. 整合後、momo-db の `pnpm db:check`、Summit integration test、`/status`、構造化ログを確認する
6. 事後に PR または incident 記録へ原因と再発防止を残す。設計不変条件や SOP が変わる場合は `docs/db-rule.md` と本書を同時に更新する

**原則**: 本番 migration 失敗は **事故案件**。復旧のためでも production DB の手動 mutation を行わない。

## CI での検査

- `momo-db` CI: `db:check` で migration 履歴の整合性検証
- `summit` CI `integration-db` ジョブ: 実 postgres service に `momo-db` の `pnpm db:migrate` を流して integration テスト実行

これらが全 green になってから本番 deploy する。
