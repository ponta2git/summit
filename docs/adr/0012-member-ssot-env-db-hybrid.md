---
adr: 0012
title: member SSoT を env+DB ハイブリッドに統合する
status: accepted
date: 2026-04-23
supersedes: []
superseded-by: null
tags: [runtime, db, ops]
---

# ADR-0012: member SSoT を env+DB ハイブリッドに統合する

## Context
固定 4 名の member 情報が現状 4 箇所に分散している。

- `env.MEMBER_USER_IDS`: Discord user ID の 4 件。membership gate の根拠。
- `src/members.ts` の `DISPLAY_NAMES`: 表示名の配列。env の ID 順序と **positional coupling** しており、配列順を reorder すると表示名がズレる。
- DB `members` テーブル: UUID ↔ Discord ID の map。`display_name` 列が無い。
- `requirements/base.md` §18-21: 運用上の初期 member 定義。

この分散により次の事故が顕在化している。

- env の ID を入れ替えると `pnpm db:seed` を再実行しないと `interactions.ts:187` で "メンバー登録がありません" エラーになり、runtime が詰む。
- `DISPLAY_NAMES` の positional coupling が "env 配列の順序を変えない" という暗黙契約を強制し、レビューでは検知しづらい。
- 表示名変更のたびに source 編集 → deploy が必要で、軽微な命名変更のコストが過剰。

## Decision
member 情報の責務を分離し、以下の SSoT 階層を採用する。

- **集合の SSoT = `env.MEMBER_USER_IDS`**: 「誰が参加者か」の唯一の根拠。membership gate もここを引く。
- **表示名の SSoT = DB `members.display_name` 列**: Discord ID → 表示名の map。migration で列を追加し、初期値は `requirements/base.md` §18-21 に従う。
- **boot 時に `reconcileMembers(env → DB)` を実行**: env に存在する ID を DB へ idempotent upsert（無ければ挿入、あれば維持）。cron 登録より前に完了させる。
- **`src/members.ts` の `DISPLAY_NAMES` 配列を廃止**する。positional coupling を排除。
- migration を 1 本切る（`members.display_name` 列追加 + backfill）。

## Consequences

### 得られるもの
- 表示名の変更がデプロイ不要になり、DB 更新のみで反映できる。
- env 変更時の "seed 忘れ" 事故が消える（boot reconcile で自動吸収）。
- positional coupling 解消により、env 配列の順序が意味を持たなくなる。
- membership gate は env を直接引くため DB round trip が発生しない（interaction ごとに DB を叩かない）。

### 失うもの / 制約
- migration が 1 本増える（列追加 + 初期値 backfill）。
- boot 順序に member reconcile ステップが挟まる。reconcile 失敗時は起動停止させる invariant を明示する必要がある。
- 表示名の履歴（旧名 → 新名）を残したい場合は別途検討（現時点では不要）。

### 運用上の含意
- 新メンバー追加時は `env.MEMBER_USER_IDS` に ID を追加してデプロイ → boot reconcile が DB に自動挿入 → DB で `display_name` を UPDATE、の順。
- 表示名変更は DB UPDATE のみ。デプロイ不要。
- env から ID を削除した場合、DB レコードは残す（履歴保全）。reconcile は upsert-only で DELETE しない。

## Alternatives considered

### 代替案 A: env-only（表示名も env 化）
却下。env が膨らみ、表示名変更のたびに Fly secrets 更新 + 再起動が必要になる。さらに env 内の「ID と表示名の対応」を文字列で表現する必要があり、positional coupling か key=value 文字列 parse のどちらかで結局壊れやすい構造になる。

### 代替案 B: DB-only（membership gate も DB で判定）
却下。interaction ごとに DB round trip が発生する。固定 4 名の membership 判定は env で十分冪等であり、runtime 依存を増やす便益が無い。

### 代替案 C: 現状維持
却下。positional coupling と seed 忘れによる runtime 停止リスクが解消されない。AI エージェントが env を編集した際、`pnpm db:seed` の実行を忘れる事故は実際に発生している。
