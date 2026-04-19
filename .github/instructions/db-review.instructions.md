---
applyTo: "src/db/**/*.ts,drizzle.config.ts"
---

# DB Safety Review Rules

本 Bot は **DB を正本**に状態遷移と再描画を行う。Discord 表示は永続化された状態から都度再構築する。本書は `src/db/**/*.ts` と `drizzle.config.ts` に適用する。

## Required patterns
- アプリ DB クライアントは `DATABASE_URL`（pooled）を使い、Neon の PgBouncer（transaction pooling）互換のため `postgres(url, { prepare: false })` を明示する。
- `DIRECT_URL` は **`drizzle.config.ts` だけで参照する**。`src/**` から参照しない（アプリ実行時 env にも含めない）。
- migration は `drizzle-kit generate` + `drizzle-kit migrate` のみ。`drizzle-kit push` は使わない（生成済み SQL の履歴を正本とするため）。
- スキーマ変更フロー: 編集 → `pnpm db:generate` で `drizzle/` に SQL 差分を出力 → レビュー → `pnpm db:migrate` で適用 → `pnpm db:check` で履歴整合確認。
- Session / Response の状態遷移は `db.transaction(async (tx) => { ... })` と**条件付き `UPDATE ... WHERE status = ...`** で原子的に行う。read-modify-write を裸で書かない。
- Response の二重投入は `(sessionId, memberId)` の unique 制約で排除する。競合時は再取得して再描画する。
- 動的 SQL は Drizzle のプレースホルダを徹底し、`sql.raw()` にユーザー入力を渡さない。動的 ORDER BY や列名切替は**許可カラム名のホワイトリスト**で解決する。
- cron と interaction の競合を前提に設計する。単一プロセスでも同時押下は発生する。
- 起動時に**終端でない状態**（`COMPLETED` / `SKIPPED` 以外）の Session を DB から読み込み、締切・リマインド予定を再計算する。in-memory 状態を正本にしない。同一 tick で二重実行されても結果が変わらないよう冪等にする。

## Observed anti-patterns
- read-modify-write の裸実装で、同時押下時に後勝ちで上書きロストする。
- `sql.raw()` に文字列連結で入力値を渡し、注入余地を作る。
- `DIRECT_URL` を実行時 env として扱い、アプリコードから参照する。
- `drizzle-kit push` で本番スキーマを直接変更する。
- プロセス内キャッシュに状態を握り、再起動で喪失する／次 tick で不整合を起こす。

## Review checklist
- transaction 境界が「4 名同時押下」「cron と interaction の同時発火」に耐えるか。
- migration 運用が generate → レビュー → migrate → check のフローに沿っているか。
- Session / Response の一意性（週キー × 順延回数、Session × メンバー）が DB 側の制約で担保されているか。
- 再起動後に進行中 Session を DB だけから完全復元できるか。
- Discord 表示失敗で DB 状態を巻き戻していないか（巻き戻さないのが正）。
