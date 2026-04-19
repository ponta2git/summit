---
applyTo: "src/db/**/*.ts,drizzle.config.ts"
---

# DB Safety Review Rules

## Required patterns
- DB クライアントは `postgres(url, { prepare: false })` を明示する。
- 状態遷移は `db.transaction(...)` と条件付き `UPDATE ... WHERE status = ...` で原子的に扱う。
- `responses` は unique(`sessionId`, `memberId`) を前提に重複投入へ耐性を持たせる。
- 動的 SQL は Drizzle のプレースホルダを使い、`sql.raw()` を避ける。
- `DIRECT_URL` は `drizzle.config.ts` のみで扱い、`src/**` で参照しない。
- migration は `drizzle-kit generate` + `drizzle-kit migrate` を使用し、`drizzle-kit push` を使わない。

## Observed anti-patterns
- read-modify-write の裸実装で競合時に上書きロストする。
- `sql.raw()` に入力値を連結して注入余地を作る。
- `DIRECT_URL` を実行時 env として扱う。

## Review checklist
- transaction 境界が競合シナリオに十分か。
- migration 運用が generate/migrate/check フローに沿っているか。
- DB 正本設計（再起動復元・冪等）が崩れていないか。

## 参照
- `requirements/base.md` §8, §9, §13
- `.github/instructions/runtime.instructions.md`
- `AGENTS.md`
