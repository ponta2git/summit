---
adr: 0016
title: customId codec を typed にする（HMAC 署名は現時点で却下）
status: accepted
date: 2026-04-23
supersedes: []
superseded-by: null
tags: [discord, runtime]
---

# ADR-0016: customId codec を typed にする（HMAC 署名は現時点で却下）

## Context
Discord Component の `custom_id` は現状 `ask:{uuid}:{choice}` / `postpone:{uuid}:{ok|ng}` の文字列フォーマットで、`interactions.ts` 内で regex + `split(":")` による直書きパースが行われている。

- kind（`ask` / `postpone`）・`sessionId`・`choice` の型が handler 層まで伝搬せず、handler 内で再度 narrow が必要。
- regex / split が複数箇所に散在し、フォーマット変更時の更新漏れリスクがある。
- 一方、脅威モデルは限定的: **固定 private guild / 固定 4 名 / 全員が信頼関係**。Discord の interaction payload には user ID が Discord 署名済みで含まれ、`actor` の詐称は不可。

この環境下で「typed codec を導入して regex 散在を解消する」ことと、「HMAC 署名で custom_id の改竄耐性を持たせる」ことは別問題として評価できる。

## Decision
typed codec を導入し、HMAC 署名は現時点で導入しない。

- **`src/discord/customId.ts` を新設**し、zod discriminated union で `CustomId` 型を定義する:
  ```ts
  type CustomId =
    | { kind: "ask"; sessionId: string; choice: SlotChoice }
    | { kind: "postpone"; sessionId: string; vote: "ok" | "ng" };
  ```
- `encode(customId: CustomId): string` と `decode(raw: string): Result<CustomId, AppError>` を 1 箇所で提供する（`AppError` は ADR-0015）。decode 失敗は `AppError.kind = "Validation"`。
- `interactions.ts` の regex / split を廃止し、dispatcher は `decode` の `Result` を受けて kind で分岐する。
- **HMAC 署名 / `messageId` binding / replay-age 検証 / version 番号は現時点で導入しない**。理由: 固定 private guild + 4 名信頼モデルにおいて、attacker 仮説が乏しく、署名コスト（secret 管理 / rotation 運用 / decode の複雑化）の便益が薄い。
- **将来の再評価トリガ**: 外部 guild への展開、人数拡大、悪意ある member を脅威モデルに含める必要が出た時点で新 ADR を起票し、HMAC + version 番号 + secret rotation を設計する。

## Consequences

### 得られるもの
- `custom_id` の型が handler 層まで伝搬し、`choice` / `vote` の narrow が型システムで保証される。
- regex / split の散在が消え、フォーマット変更が `src/discord/customId.ts` 1 箇所で完結する。
- HMAC 未導入でも、`interaction.user.id` は Discord 側で署名済みのため **actor 詐称は構造上不可**。4 名以外の user は `env.MEMBER_USER_IDS` のチェックで reject される。

### 失うもの / 制約
- `custom_id` の**内容**は改竄可能（Discord client からは見える）。ただし改竄しても sessionId が存在しない / state が不一致なら DB 側で reject される（CAS + unique 制約）。
- replay（古い `custom_id` の再送信）は防げない。ただし state 遷移後の custom_id は CAS で無視されるため、実害は無い。
- 将来 HMAC を導入する場合、既存の `custom_id` フォーマットとの後方互換を取るため version 番号の追加コストが発生する。

### 運用上の含意
- `src/discord/customId.ts` は zod schema の SSoT。フォーマット変更は本ファイル 1 箇所 + version bump（将来 HMAC 化する場合）で行う。
- decode 失敗時は ephemeral reject + `logger.warn({ kind: "Validation", raw })`。ログに raw custom_id を残すこと自体はリスクが低い（secret を含まないため）。

## Alternatives considered

### 代替案 A: HMAC 署名を即導入する
却下。脅威モデル（固定 private guild / 4 名 / 全員信頼）と不一致。secret 管理（Fly secrets 追加）・rotation 運用・decode 時の比較コストが発生し、便益が乏しい。外部 guild 展開や人数拡大が見えた時点で再評価する。

### 代替案 B: 現状の regex / split を維持する
却下。typing と kind 判別で dispatch 層が整理され、future-proof な拡張ポイントになる。typed codec のコストは ~50 LOC 程度で、便益が明確に上回る。

### 代替案 C: `messageId` binding（custom_id に message ID を埋める）
却下。HMAC 無しでは改竄可能なため binding として機能せず、ただ payload が長くなるだけ。HMAC 導入時にセットで検討する。

### 代替案 D: JSON payload を base64 で詰める
却下。Discord の custom_id 制限（100 文字）に対してエンコード効率が悪く、単純なフォーマット `kind:sessionId:choice` のほうが debug しやすい。
