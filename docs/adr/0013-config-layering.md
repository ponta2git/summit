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

## TL;DR
設定を 4 層に分離する: 時間スロット enum は `src/domain/slots.ts` が唯一 SSoT、user-facing 日本語文言は `src/messages.ts`、runtime tunables（cron 式 / 締切時刻 / reminder lead）は `src/config.ts`、cosmetic（button label / emoji）は `src/constants.ts`。

## Context
設定・文言・定数がコード全体に散在し、変更のたび複数ファイルの同時編集が必要になっている。

- **時間スロット enum が 4 箇所で再宣言**: `ASK_TIME_CHOICES` (`time/index.ts`) / `RESPONSE_CHOICES` (`db/schema.ts`) / `ASK_CHOICES` (`ask/render.ts`) / `ASK_CUSTOM_ID_TO_DB_CHOICE` (`interactions.ts`)。既存コメントでは "3 箇所" と誤認されていた。スロット 1 つ追加で 4 ファイル同時変更、漏れは custom_id decode 失敗 / DB enum mismatch に直結。
- **user-facing 日本語文言が ~11 箇所に散在**: `ask/render.ts:90,93,167,170` / `settle.ts:92-93` / `postponeMessage.ts:42` / `interactions.ts:104,108,269` ほか。文言レビューが横断検索前提。
- **runtime tunables が複数ファイルに散在**: cron 式・`SLOT_MINUTES`・deadline 時刻・reminder lead が scheduler / settle / render に分散。
- **cosmetic 定数も同様に散在**: button label / emoji / ButtonStyle / reject 文言が render / interactions 各所で直書き。

## Decision
設定を責務で 4 層に分離する。実値は各ファイルが SSoT、本 ADR には値を書き写さない（ADR-0022）。

- **`src/domain/slots.ts`**: 時間スロット enum の唯一 SSoT。custom_id map / DB enum / render choice 配列の 3 箇所は**すべて本 SSoT からの派生**として型で生成し、スロット追加時のコンパイル時漏れ検知を効かせる。
- **`src/messages.ts`**: user-facing 日本語文言を集約。slot / member 名の埋め込みは template function の型付き引数で受ける。
- **`src/config.ts`**: runtime tunables（cron 式 / 締切時刻 / reminder lead / slot 時刻 map）。env override は将来拡張として予約、現時点ではコード定数。
- **`src/constants.ts`**: cosmetic（button label / emoji / ButtonStyle / reject 文言キー）。messages との違いは「業務文言か UI 部品か」。

### Invariants
- **i18n は当面やらない**。4 名日本語固定前提のため i18next 等は overkill。拡張が必要になったら `src/messages.ts` を locale map に置き換える形で対応。

## Consequences

### Follow-up obligations
- 新スロット追加は `src/domain/slots.ts` にのみ書き、派生先（custom_id map / DB enum / render choice 配列）は型エラーを解消する形で追従する。
- 文言変更は `src/messages.ts` のみで完結させる。cron 時刻変更は `src/config.ts` で行う。

### Operational invariants & footguns
- cron 式・時刻閾値を変更する場合、デプロイ禁止窓（金 17:30〜土 01:00 JST）を必ず確認する。
- i18n は当面やらない（4 名日本語固定前提）。必要になったら `src/messages.ts` を locale map に置き換える拡張路線で、i18next 等の導入は再評価の対象とする。
- 設定値はコード定数（各 SSoT ファイル）で保持し、ADR・コメントへ書き写さない（ADR-0022）。drift 源になる。

## Alternatives considered

- **A: i18next 即導入** — 4 名日本語前提 1500 LOC 規模に runtime 依存 + locale file 運用は overkill。拡張余地は `src/messages.ts` の map 化で残す。
- **B: 単一 `constants.ts` に集約** — messages / cron / cosmetic はレビュー粒度と担当者が異なり、混ぜると PR 差分の意味付けが薄れる。
- **C: 現状維持（散在）** — スロット enum が 4 箇所で再宣言されており、1 箇所の更新漏れが custom_id decode 失敗 / DB enum mismatch に直結する事故の温床。
- **D: env 経由で全 runtime tunable を外部化** — 現時点で env override が必要な tunable は無く env スキーマが肥大化する。必要になった項目だけ昇格させる。
