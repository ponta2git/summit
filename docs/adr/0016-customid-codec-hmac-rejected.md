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

## TL;DR
`src/discord/customId.ts` で zod discriminated union の typed codec（`encode` / `decode`）を提供し、regex + split の散在を解消する。HMAC 署名は固定 private guild / 4 名信頼モデルに対して過剰なため**現時点では導入せず**、外部展開や人数拡大時に再評価する。

## Context
Discord Component の `custom_id` は `ask:{uuid}:{choice}` / `postpone:{uuid}:{ok|ng}` 形式で、`interactions.ts` 内の regex + `split(":")` による直書きパースで処理されている。

- kind（`ask` / `postpone`）・`sessionId`・`choice` の型が handler 層に伝搬せず、handler 内で再 narrow が必要。
- regex / split が複数箇所に散在し、フォーマット変更時の更新漏れリスクがある。
- 脅威モデルは限定的: **固定 private guild / 固定 4 名 / 全員信頼**。`interaction.user.id` は Discord 側で署名済みで actor 詐称は構造上不可。

この条件下で「typed codec 導入による regex 散在の解消」と「HMAC 署名による改竄耐性付与」は別問題として独立評価できる。

## Decision
typed codec を導入し、HMAC 署名は**現時点で導入しない**。

### Codec
- **`src/discord/customId.ts` を新設**し zod discriminated union で `CustomId` 型（`ask` / `postpone` kind）を定義。@see `src/discord/customId.ts`
- 提供 API: `encode(customId): string` と `decode(raw): Result<CustomId, AppError>`（`AppError` は ADR-0015、decode 失敗は `kind = "Validation"`）。
- `interactions.ts` の regex / split を廃止し、dispatcher は `decode` の `Result` を受けて kind で分岐。

### HMAC 不採用の根拠（脅威モデル）
固定 private guild + 4 名信頼モデル下で `interaction.user.id` は Discord 側で署名済み、**actor 詐称は構造上不可**。custom_id 内容は改竄可能だが、sessionId 不存在 / state 不一致は DB 側で reject される（CAS + unique）。replay も state 遷移後は CAS で無視され実害なし。

### 再評価トリガ
外部 guild 展開 / 人数拡大 / 悪意ある member を脅威モデルに含める必要が出た時点で新 ADR を起票し、HMAC + version 番号 + secret rotation をセット設計する。

### Invariants
- フォーマット変更は `src/discord/customId.ts` 1 箇所 + 将来 HMAC 化する場合は version bump。
- decode 失敗は ephemeral reject + `logger.warn({ kind: "Validation", raw })`（raw は secret 非含で低リスク）。

## Consequences

### Follow-up obligations
- `src/discord/customId.ts` を新設し、`interactions.ts` の regex / split を `decode` の Result に置換する。
- dispatcher は `decode` の `Result` を受けて kind で分岐する（`AppError.kind = "Validation"`、ADR-0015）。

### Operational invariants & footguns
- フォーマット変更は **`src/discord/customId.ts` 1 箇所 + 将来 HMAC 化する場合は version bump** で行う（散在復活させない）。
- decode 失敗時は ephemeral reject + `logger.warn({ kind: "Validation", raw })`。raw は secret を含まない前提（含める拡張をしない）。
- `custom_id` の**内容**は改竄可能。sessionId 不存在 / state 不一致は DB 側で reject される（CAS + unique）想定で dispatch を書く。replay は CAS で実害なし。
- 再評価トリガは Alternatives に集約。HMAC 導入時は `messageId` binding / version / secret rotation をセット設計する。

## Alternatives considered

- **A: HMAC 署名を即導入** — 脅威モデル（固定 private guild / 4 名 / 全員信頼）と不一致で、secret 管理・rotation・比較コストが発生する割に便益が乏しい。外部展開や人数拡大時に再評価。
- **B: 現状の regex / split 維持** — typed codec（~50 LOC）で kind 判別 dispatch が整理され future-proof な拡張点になり、便益が明確に上回る。
- **C: `messageId` binding（custom_id に埋込）** — HMAC 無しでは改竄可能で binding として機能せず payload が伸びるだけ。HMAC 導入時にセットで検討。
- **D: JSON payload を base64 で詰める** — Discord 100 文字制限に対しエンコード効率が悪く、`kind:sessionId:choice` のほうが debug しやすい。
