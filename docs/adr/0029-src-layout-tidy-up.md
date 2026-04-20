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

## Context

ADR-0025〜ADR-0028 で feature 同梱と shared 境界を整理した段階で、`src/` 直下と `src/db/` に以下の違和感が残っていた。

1. **dev ツールが `src/db/` に混入**: `src/db/seed.ts`（`pnpm db:seed`）と `src/db/devReset.ts`（`pnpm db:reset`）は runtime ではなく CLI ツール。`src/` は本番起動時に import されるコードの場所という取り決めに反する。既に `scripts/dev/scenario.ts` が先例として存在。
2. **generic 名のファイル**: `src/db/types.ts` は内容が「Row 型 + drizzle 派生型の集約」で、ロジックと共存する `types.ts` アンチパターンに該当。内容が明快なのに名前だけ抽象的で grep 可読性も落ちる。
3. **`src/composition.ts` の命名**: 実体は `AppContext` interface + `createAppContext()` factory。「composition root」は説明のラベルとしては正しいが、他ファイル（`src/db/ports.real.ts` 等）も部分的な composition を担うため、ファイル名は **一次エクスポートで命名する**（`appContext.ts`）方が意図が直接伝わる。
4. **`src/slot.ts` と `src/discord/shared/customId.ts` の境界不明**: 両方が「wire format」に関与するように見え、命名だけでは区別がつきにくい。実際は `slot.ts` = 「スロット値」の domain + wire 変換 SSoT、`customId.ts` = 「3-segment custom_id 文字列全体」の codec で責務が異なる。

## Decision

### 1. dev ツールを `scripts/dev/` へ退避

- `git mv src/db/seed.ts scripts/dev/seed.ts`
- `git mv src/db/devReset.ts scripts/dev/reset.ts`
- `package.json` の `db:seed` / `db:reset` を更新
- 内部の import を `scripts/dev/scenario.ts` 方式（`../../src/db/client.js` 等）に統一
- `src/db/` は runtime 専用（schema / repositories / ports / client / rows）。

### 2. `src/db/types.ts` → `src/db/rows.ts`

中身が Row 型集約なので、名前を役割に合わせる。`types.ts` という generic 名は以後採用しない（型しか置かないファイルは役割を示す名前にする）。

### 3. `src/composition.ts` → `src/appContext.ts`

一次エクスポートである `AppContext` に合わせた命名。`createAppContext` は引き続き composition root として機能するが、ファイル名が定義を直接示すようになり、ADR-0018 の「AppContext 経由で依存注入」という運用が grep で追いやすくなる。

### 4. `slot.ts` と `customId.ts` の境界を文書化

コードの責務は変えない。以下の 2 点のみ追加:

- `src/slot.ts` にヘッダコメントで「slot 値の domain + wire SSoT」であること、および `customId.ts` との境界を明記。ファイル内を `// --- domain ---` / `// --- customId wire ---` / `// --- DB wire ---` の 3 section に並べ替え。
- `src/discord/shared/customId.ts` にヘッダコメントで「3-segment interaction custom_id 文字列の codec」であること、および slot 値の意味は `slot.ts` に委譲していることを明記。

## Consequences

- `src/` 以下は「本番起動時の runtime 専用」という invariant が成立。CI で `src/` ↔ `scripts/` の役割混入を今後も避けやすい（grep で `pnpm tsx src/db/...` が出たら違反）。
- `src/db/rows.ts` / `src/appContext.ts` は意図を直接示す名前になり、新規参加者の読解コストが下がる。
- `slot.ts` と `customId.ts` のヘッダコメントで境界が明文化され、「どちらに追記すればいいか」を毎回判断する必要がなくなる。
- 本番コードの挙動・API は一切変わらない。import path の機械的書き換えのみ（合計 ~50 サイト）。
- 過渡期コスト: 旧パスの参照（AGENTS.md / README.md / `.oxlintrc.json` / `scripts/verify/forbidden-patterns.sh` / `.github/**/*.md` / ADR-0018, ADR-0020 本文）を同時更新。

## Alternatives considered

- **`src/db/types.ts` を schema.ts に統合**: 棄却。`$inferSelect` narrowing + `DbLike` 等の合成型があり、schema.ts を肥大化させると「drizzle テーブル定義」と「アプリで使う Row 型」が混在して却って読みにくい。ファイル分離 + 意味ある名前（`rows.ts`）が最良。
- **`src/composition.ts` のまま**: 棄却。composition root というラベルは運用概念（`src/db/ports.real.ts`、`src/index.ts`、テストの `tests/testing/ports.ts` も部分的に composition を担う）で、**ファイル名** としては一次エクスポートを取る方が grep 性能が高い。
- **slot.ts を `slot/` ディレクトリに分解**（domain.ts / customIdWire.ts / dbWire.ts）: 棄却。現段階ではファイル内のコード量が少なく（62 行）、分割すると逆に 3 ファイル間の import が増える。section コメントで十分。将来拡張時に再評価する。
- **dev ツールを `src/scripts/` 等の `src/` 下別階層**: 棄却。`tsconfig.build.json` の対象や CI の `src/` 前提と整合させる労力が増す。既に `scripts/dev/scenario.ts` が定着しているのでそれに合流させるのが最小コスト。

## References

- `scripts/dev/seed.ts`, `scripts/dev/reset.ts`, `scripts/dev/scenario.ts`
- `src/db/rows.ts`, `src/appContext.ts`
- `src/slot.ts`, `src/discord/shared/customId.ts`
- `package.json` scripts `db:seed` / `db:reset`
- ADR-0013, ADR-0016, ADR-0018, ADR-0022, ADR-0025, ADR-0026
