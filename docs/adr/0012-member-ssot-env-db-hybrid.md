---
adr: 0012
title: member SSoT を env+DB ハイブリッドに統合する
status: superseded
date: 2026-04-23
supersedes: []
superseded-by: 0046
tags: [runtime, db, ops]
---

# ADR-0012: member SSoT を env+DB ハイブリッドに統合する

## TL;DR
member 情報の SSoT を分離する: 「誰が参加者か」は `env.MEMBER_USER_IDS`、表示名は DB `members.display_name`。boot 時の `reconcileMembers(env → DB)` で idempotent upsert し、`DISPLAY_NAMES` の positional coupling を廃止する。

## Context
member 情報の SSoT が 4 箇所に分散している。

- `env.MEMBER_USER_IDS`: Discord user ID 4 件。membership gate の根拠。
- `src/members.ts` の `DISPLAY_NAMES`: 表示名配列。env の ID 順と **positional coupling**（配列順を reorder すると表示名がズレる）。
- DB `members` テーブル: UUID ↔ Discord ID の map。`display_name` 列は無い。
- `requirements/base.md` §18-21: 運用上の初期 member 定義。

この分散から次の事故が顕在化している。

- env の ID を入れ替えると `pnpm db:seed` 再実行なしに `interactions.ts:187` で "メンバー登録がありません" エラーで runtime が詰む。
- `DISPLAY_NAMES` の positional coupling が "env 配列の順序を変えない" という暗黙契約を強制し、レビューで検知しづらい。
- 表示名変更のたびに source 編集 → deploy が必要で、軽微な命名変更のコストが過剰。

## Decision
member 責務を分離し、以下の SSoT 階層を採用する。

### SSoT
- **集合 = `env.MEMBER_USER_IDS`**: 「誰が参加者か」の唯一根拠。membership gate もここを引き DB round trip を避ける。
- **表示名 = DB `members.display_name` 列**: migration で列追加、初期値は `requirements/base.md` §18-21。

### Boot flow
- **`reconcileMembers(env → DB)` を cron 登録より前に実行**。env の ID を DB へ **idempotent upsert**（無ければ挿入 / あれば維持）。失敗時は起動停止。
- **upsert-only、DELETE しない**（env から削除された ID でも DB レコードは履歴保全のため残す）。

### Invariants
- **`src/members.ts` の `DISPLAY_NAMES` 配列は廃止**し positional coupling を排除。env 配列順は意味を持たない。
- migration 1 本（`members.display_name` 列追加 + backfill）。

## Consequences

### Follow-up obligations
- migration 1 本（`members.display_name` 列追加 + 初期値 backfill）を追加する。
- boot 順序: `reconcileMembers(env → DB)` を cron 登録より前に実行する層を `src/index.ts` に挿入する。
- `src/members.ts` の `DISPLAY_NAMES` 配列を廃止し、positional coupling を排除する。

### Operational invariants & footguns
- **reconcile 失敗時は起動停止**（DB 到達不能で membership gate の前提が崩れたまま稼働させない）。
- **upsert-only / DELETE しない**: env から ID を削除しても DB レコードは履歴保全のため残す。孤立行が残る想定で downstream を組む。
- 新メンバー追加は「env に ID 追加 → デプロイ → boot reconcile が DB 挿入 → DB で `display_name` を UPDATE」の順。表示名単独変更はデプロイ不要で DB UPDATE のみ（デプロイ禁止窓に影響されない）。
- 表示名の履歴（旧名 → 新名）は保持しない。履歴要件が出たら別途設計。

## Alternatives considered

- **A: env-only（表示名も env 化）** — env が膨らみ表示名変更ごとに Fly secrets 更新 + 再起動が必要になり、ID⇔表示名対応の表現が positional coupling か文字列 parse で壊れやすい。
- **B: DB-only（membership gate も DB 判定）** — interaction ごとに DB round trip が発生。固定 4 名の判定は env で冪等に済み runtime 依存を増やす便益が無い。
- **C: 現状維持** — positional coupling と seed 忘れによる runtime 停止リスクが解消されず、実際に AI エージェントの seed 忘れ事故が発生している。
