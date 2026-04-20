---
adr: 0013
title: config 階層（messages / config / constants / domain slots SSoT）
status: accepted
date: 2026-04-23
supersedes: []
superseded-by: null
tags: [runtime, docs]
---

# ADR-0013: config 階層（messages / config / constants / domain slots SSoT）

## Context
設定・文言・定数がコード全体に散在しており、変更の都度複数ファイルを同時編集する必要がある。

- **user-facing 日本語文言が ~11 箇所に散在**: `ask/render.ts:90,93,167,170` / `settle.ts:92-93` / `postponeMessage.ts:42` / `interactions.ts:104,108,269` ほか。文言レビューが横断検索前提になっている。
- **runtime tunables が複数ファイルに散在**: cron 式 `"0 8 * * 5"` / `"30 21 * * 5"`、`SLOT_MINUTES`、deadline 時刻、reminder lead `-15 分` などが scheduler / settle / render に分散。
- **cosmetic 定数も同様に散在**: button label / emoji / ButtonStyle / reject 文言が render / interactions の各所で直書き。
- **時間スロット enum が 4 箇所で再宣言**: `ASK_TIME_CHOICES` (`time/index.ts`) / `RESPONSE_CHOICES` (`db/schema.ts`) / `ASK_CHOICES` (`ask/render.ts`) / `ASK_CUSTOM_ID_TO_DB_CHOICE` (`interactions.ts`)。既存コメントでは "3 箇所" と誤認されていた。スロット 1 つ追加すると 4 ファイル同時変更が必要。

## Decision
設定を責務で 4 層に分離する。

- **`src/domain/slots.ts`**: 時間スロット enum の唯一 SSoT（`T2200` / `T2230` / `T2300` / `T2330` / `ABSENT`）。他の 3 箇所（custom_id map / DB enum / render 用 choice 配列）はすべてこの SSoT からの派生として生成する。
- **`src/messages.ts`**: user-facing 日本語文言を集約。slot や member 名の埋め込みは template function の型付き引数で受ける。
- **`src/config.ts`**: runtime tunables（cron 式 / 締切時刻 / reminder lead / slot 時刻 map）。env override は将来拡張として予約するが、現時点ではコード定数で良い。
- **`src/constants.ts`**: cosmetic（button label / emoji / ButtonStyle / reject 文言キー）。messages との違いは "業務文言か UI 部品か"。

## Consequences

### 得られるもの
- 文言レビューが `src/messages.ts` 1 ファイルで完了する。
- 時間スロット追加・変更が `src/domain/slots.ts` の 1 箇所で完結し、派生先は型で追従する（コンパイル時に漏れが検知できる）。
- cron 式・締切時刻の変更が `src/config.ts` でまとまり、デプロイ窓や運用時刻の可視性が上がる。
- レビュー粒度が層で分離される（messages のレビューは業務担当、config は運用担当、domain は仕様担当）。

### 失うもの / 制約
- ファイルが 4 本増える。小規模コードベースに対してはわずかな構造コストが乗る。
- i18n は当面やらない。4 名日本語固定前提のため、i18next 等の導入コストが便益を上回る。将来多言語が必要になった場合は `src/messages.ts` を locale map に置き換える形で拡張する。

### 運用上の含意
- 新スロット追加は `src/domain/slots.ts` にのみ書き、他箇所は型エラーを解消する形で追従する。
- cron 時刻変更は `src/config.ts` の定数変更 + デプロイ。禁止窓（ADR-0005）を確認する。
- 文言変更は `src/messages.ts` のみで完結するため、コードレビューの心理的負荷が下がる。

## Alternatives considered

### 代替案 A: i18next 即導入
却下。4 名日本語前提の 1500 LOC 規模に対し runtime 依存 + locale file 運用が overkill。将来の拡張余地は `src/messages.ts` を map 化する形で残す。

### 代替案 B: 単一 `constants.ts` に全部まとめる
却下。messages（業務文言。レビュアは運用者）と cron 式（運用 tunable。レビュアはインフラ担当）と cosmetic（button UI。レビュアはフロント担当）はレビュー粒度が違う。1 ファイルに混ぜると PR 差分の意味付けが薄れる。

### 代替案 C: 現状維持（散在）
却下。スロット enum が 4 箇所で再宣言されており、1 箇所の更新漏れが runtime 誤動作（custom_id decode 失敗 / DB enum mismatch）に直結する。事故の温床。

### 代替案 D: env 経由で全 runtime tunable を外部化
却下。現時点で env override が必要な tunable は無く、env スキーマが肥大化する。将来必要になった項目だけ `src/config.ts` から env フォールバックに昇格させる。
