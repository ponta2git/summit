# Codex Instructions（summit）

Codex がこのリポジトリで作業するときの常時ルール。最初に `AGENTS.md` を読み、業務仕様は `requirements/base.md`、実装規約は `.github/instructions/*.md`、判断根拠は `docs/adr/` を参照する。

## 最優先ルール

- 時刻は JST 固定。時刻計算・週キー・締切は `src/time/` に集約し、アプリコードで `new Date()` を直接使わない。
- env は `src/env.ts` 経由で扱い、`process.env` の直接参照を増やさない。secret、接続文字列、ping URL の実値をコード・fixture・ログ・コミットに含めない。
- DB は Drizzle + postgres.js。migration は `momo-db` で `generate` → SQL レビュー → `migrate` の順に行い、`drizzle-kit push` は使わない。
- 本番 DB の破壊操作、手動 SQL、secret の不可逆変更を実行しない。Fly は単一インスタンス前提を維持する。
- Interaction は defer を先行し、入力検証 → DB の条件付き更新 → DB を正本とした再描画の順に処理する。
- 新しい handler / scheduler / workflow は `AppContext` の `ctx.ports.*` と `ctx.clock` を使い、repositories や system clock を直接 import しない。
- 仕様にない業務判断（締切・週キー・状態・参加条件・custom_id 形式など）は推測で実装せず、`todo(ai): spec clarification needed` を残して確認する。

## 検証とコミット

変更後は次を実行する。

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

コミットメッセージは英語の Conventional Commits とし、PR の説明は日本語で変更点・仮定・影響範囲・テスト・運用影響・リスクを記載する。
