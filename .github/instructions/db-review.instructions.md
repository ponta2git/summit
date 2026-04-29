---
applyTo: "src/db/**/*.ts"
---

# DB Safety Review Rules

**DB を正本**に状態遷移と再描画を行う。Discord 表示は永続化状態から都度再構築する。

> **スキーマ変更・migration の実行は `momo-db` リポジトリで行う** (`../momo-db/src/schema.ts` / `drizzle/` / `drizzle.config.ts`)。summit の `src/db/schema.ts` は `@momo/db` パッケージへの re-export shim。

## 必須ルール
- アプリ DB クライアントは `env.DATABASE_URL`（pooled）を使い、Neon PgBouncer 互換で `postgres(url, { prepare: false })` を明示。
- `DIRECT_URL` は **`momo-db` の `drizzle.config.ts` だけ**で参照（summit の `src/**` から参照禁止）。
- migration は `drizzle-kit generate` + `drizzle-kit migrate` のみ（`momo-db` で実行）。**`drizzle-kit push` 禁止**（生成済み SQL 履歴を正本とするため）。
- 状態遷移は `db.transaction(async (tx) => { ... })` と**条件付き `UPDATE ... WHERE status = ...`** で原子的に行う。read-modify-write を裸で書かない。
- `responses` の二重投入は `(sessionId, memberId)` unique で排除。競合時は再取得して再描画。
- 動的 SQL は Drizzle プレースホルダを徹底。`sql.raw()` にユーザー入力を渡さない。動的 `ORDER BY` / 列名切替は **許可カラムのホワイトリスト** で実装。
- cron と interaction の競合を前提に設計する（単一プロセスでも同時押下は起こる）。
- 起動時は**非終端**（`COMPLETED`/`SKIPPED` 以外）の Session を読み直して締切・リマインド予定を再計算。in-memory 状態を正本にしない。同一 tick 重複実行で結果が変わらないよう冪等に。
- SQL クエリログで bind 値を生出力しない（Drizzle のプレースホルダに委ねる）。
