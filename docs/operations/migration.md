# Migration Operations

drizzle-kit を用いた schema migration の生成・適用・ロールバック手順。関連 ADR: 0008 (Drizzle 採用) / 0019 (DIRECT_URL 分離)。

## 原則 (常時ルール再掲)

- migration は `drizzle-kit generate` + `drizzle-kit migrate` のみ。**`drizzle-kit push` は禁止** (`.github/instructions/db-review.instructions.md`)。
- `DIRECT_URL` は `drizzle.config.ts` 専用 (アプリ code から参照禁止、ADR-0019)。
- 金 17:30〜土 01:00 JST は migration 禁止 (AGENTS.md deploy 禁止窓)。
- CI `drift-check` ジョブで schema.ts と migration 履歴の drift を自動検出 (`.github/workflows/ci.yml`)。

## 新規 migration の作り方

```bash
# 1. src/db/schema.ts を編集
vim src/db/schema.ts

# 2. SQL を生成 (drizzle/ に出力)
pnpm db:generate

# 3. 生成 SQL をレビュー
git diff drizzle/

# 4. ローカル DB で適用テスト
pnpm db:migrate

# 5. 整合性チェック
pnpm db:check

# 6. typecheck / lint / test / build
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

生成された SQL ファイルと `drizzle/meta/` の両方を commit する。

## 本番への適用

Fly deploy 時に自動で走る (Dockerfile / release_command 参照) のが基本。手動で走らせる場合:

```bash
fly ssh console -a summit -C "pnpm db:migrate"
```

**禁止**: `fly ssh` 経由で生 SQL (`DROP` / `TRUNCATE` / 手動 `UPDATE`) を流すこと (AGENTS.md `prohibited_actions`)。

## ロールバック

drizzle-kit は **down migration を自動生成しない**。ロールバックが必要なケースは以下のいずれかで対応:

### A. 新 migration を前に進める形で打ち消す (推奨)

破壊的変更 (列削除 / 型変更) を「足して戻す」新 migration を書く。例: `DROP COLUMN foo` を戻すなら `ALTER TABLE t ADD COLUMN foo ...`。

手順:

1. `src/db/schema.ts` を直前版に戻す (git revert 相当)
2. `pnpm db:generate` で打ち消し migration を生成
3. `pnpm db:check` / test / build
4. Fly deploy で本番適用

### B. Neon PITR で時点復元 (B は A が困難な場合のみ)

データ欠損を伴う migration を戻したいなら、schema の roll-back と併せて PITR で復元する ([backup.md](./backup.md) §restore-pitr)。

## migration 失敗時の復旧 (復旧不能ケース D)

**症状**: `pnpm db:migrate` が途中で失敗し、`__drizzle_migrations` テーブルと schema 実体がずれる。

**SOP**:

1. **焦らない**。Fly deploy の release_command 失敗で新 instance は立ち上がらない (旧 instance が生き残る場合もあれば downtime になる場合もある — Fly 設定次第)
2. Neon dashboard で schema 実体と `__drizzle_migrations` の状態を確認
3. 中断地点が明確なら:
   - 中断より前の部分のみが適用された → 残りの SQL を手動で流す (Neon SQL Editor) → `__drizzle_migrations` に該当行を手 INSERT して整合を取る
   - 中断より後の部分まで壊れている → Neon PITR で migration 直前に戻し、migration を修正して再度 `pnpm db:migrate`
4. 整合後、`pnpm db:check` で確認
5. 事後に ADR 候補として経緯を記録 (AGENTS.md ADR プロトコル)

**原則**: 本番 migration 失敗は **事故案件**。事後に必ず ADR か PR 説明で再発防止を記録する。

## CI での検査

- `static-baseline` ジョブ: `pnpm db:check` で migration 履歴の整合性検証
- `drift-check` ジョブ: `pnpm verify:drift` で schema.ts と最新 migration の drift 検出
- `integration-db` ジョブ: 実 postgres service に `pnpm db:migrate` を流して integration テスト実行

これらが全 green になってから本番 deploy する。
