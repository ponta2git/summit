---
adr: 0029
title: src ディレクトリの整理（dev ツール退避 / ファイル名の意図整合）
status: accepted
date: 2026-04-25
supersedes: []
superseded-by: null
tags: [runtime, docs, dev-tools]
---

# ADR-0029: src ディレクトリの整理（dev ツール退避 / ファイル名の意図整合）

## TL;DR
dev ツール `src/db/seed.ts` / `src/db/devReset.ts` を `scripts/dev/` へ退避し `src/` を runtime 専用に保つ。`src/db/types.ts` → `src/db/rows.ts`、`src/composition.ts` → `src/appContext.ts` と一次エクスポートに合わせてリネーム。`slot.ts` / `customId.ts` の境界はヘッダコメントで文書化（実装変更なし）。

## Context

ADR-0025〜ADR-0028 後に `src/` 直下と `src/db/` に残った不整合:

1. **dev ツールが `src/db/` に混入**: `seed.ts` / `devReset.ts` は CLI ツールで `pnpm db:seed` / `pnpm db:reset` 専用。「`src/` = 本番起動時に import されるコード」の不変条件に反する。`scripts/dev/scenario.ts` に先例あり。
2. **generic 名**: `src/db/types.ts` は Row 型集約だが名前が抽象的で grep 性が低く、ロジックと共存する `types.ts` アンチパターン。
3. **composition.ts の命名ズレ**: 一次 export は `AppContext` + `createAppContext()`。他にも部分的 composition を担うファイル（`src/db/ports.real.ts` 等）があり、ファイル名は一次 export 名に揃える方が ADR-0018 の grep 動線に合う。
4. **`slot.ts` と `customId.ts` の責務境界不明**: 命名上どちらも「wire format」に見えるが実態は slot 値 SSoT vs 3-segment custom_id codec で異なる。

## Decision

### 1. dev ツールを `scripts/dev/` へ退避

- `src/db/seed.ts` → `scripts/dev/seed.ts`、`src/db/devReset.ts` → `scripts/dev/reset.ts`（`git mv`）。
- `package.json` の `db:seed` / `db:reset` を更新。internal import は `scripts/dev/scenario.ts` 方式（`../../src/db/client.js` 等）に統一。
- **invariant**: `src/db/` は runtime 専用（schema / repositories / ports / client / rows）。

### 2. `src/db/types.ts` → `src/db/rows.ts`

Row 型集約という役割を名前で示す。以後 `types.ts` という generic 名は採用しない。

### 3. `src/composition.ts` → `src/appContext.ts`

一次エクスポート `AppContext` に合わせる。ADR-0018 の「AppContext 経由で依存注入」が grep で追いやすくなる。

### 4. `slot.ts` と `customId.ts` の境界を文書化（実装不変）

- `src/slot.ts`: ヘッダコメントで「slot 値の domain + wire SSoT」を明記し、ファイル内を `// --- domain ---` / `// --- customId wire ---` / `// --- DB wire ---` の 3 section に並べ替え。
- `src/discord/shared/customId.ts`: ヘッダコメントで「3-segment interaction custom_id 文字列の codec」であること、slot 値の意味は `slot.ts` に委譲することを明記。

## Consequences

### Follow-up obligations
- 旧パス参照（AGENTS.md / README.md / `.oxlintrc.json` / `scripts/verify/forbidden-patterns.sh` / `.github/**/*.md` / ADR-0018・ADR-0020 本文）を同 PR で同時更新する。残ると grep 誘導と forbidden-patterns 検証が壊れる。

### Operational invariants & footguns
- `src/` 配下は「本番起動時の runtime 専用」を不変条件として維持する。開発スクリプトから `pnpm tsx src/db/...` のような侵食が出た場合は `scripts/verify/forbidden-patterns.sh` で検知する前提（役割混入を CI で弾く）。

## Alternatives considered

- **`src/db/types.ts` を schema.ts に統合** — テーブル定義とアプリ Row 型が混在し読みにくくなるため却下。
- **`src/composition.ts` のまま** — composition は複数ファイルに跨る運用概念で、ファイル名としては一次 export 名の方が grep しやすいため却下。
- **`slot/` ディレクトリに分解**（domain.ts / customIdWire.ts / dbWire.ts） — 現在 62 行と小規模で分割は逆に import を増やすだけのため却下。
- **dev ツールを `src/` 下別階層に配置** — `tsconfig.build.json` や CI の `src/` 前提との整合コストが増し、既存 `scripts/dev/` に合流させる方が最小コストのため却下。

## References

- `scripts/dev/seed.ts`, `scripts/dev/reset.ts`, `scripts/dev/scenario.ts`
- `src/db/rows.ts`, `src/appContext.ts`
- `src/slot.ts`, `src/discord/shared/customId.ts`
- `package.json` scripts `db:seed` / `db:reset`
- ADR-0013, ADR-0016, ADR-0018, ADR-0022, ADR-0025, ADR-0026
