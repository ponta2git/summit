---
adr: 0030
title: slot.ts を pure domain に縮小し slot wire を customId.ts に集約
status: accepted
date: 2026-04-27
supersedes: []
superseded-by: null
tags: [runtime, discord, docs]
---

# ADR-0030: slot.ts を pure domain に縮小し slot wire を customId.ts に集約

## TL;DR
`src/slot.ts` は pure domain（`SlotKey` / `SLOT_KEYS` / `slotKeySchema` / `SLOT_TO_MINUTES`）のみ ~20 行に縮小する。customId wire（`CUSTOM_ID_SLOT_CHOICES` 等）は `src/discord/shared/customId.ts` へ移設し単一所有にする。identity でしかなかった DB wire 層（`DbSlotChoice` 型と変換関数 4 つ）は**完全削除**し、DB は SlotKey を verbatim 保存する事実を明示する。

## Context

ADR-0029 では `slot.ts` 内部を「domain / customId wire / DB wire」の 3 section にコメント区分した。直後のレビューで「コメント区分では不十分」と指摘され、実装を再精査した結果:

1. **DB wire section は完全な identity**: `DbSlotChoice` は `SlotKey` の type alias、`SLOT_KEY_TO_DB_CHOICE` / `DB_CHOICE_TO_SLOT_KEY` は identity object、変換関数 2 つも identity。DB は SlotKey 文字列を verbatim 保存しており変換層が存在する理由がない。真の「ask の DB 列挙」（ABSENT 含む 5 値）は `features/ask-session/choiceMap.ts` が所有。→ dead ceremony。
2. **customId wire の consumer は 2 箇所**: `discord/shared/customId.ts` と `features/ask-session/render.ts`。どちらも custom_id 文字列を扱う文脈で、`customId.ts` 同居が自然。
3. **pure domain のみが真の cross-cutting**: `SlotKey` / `SLOT_KEYS` / `slotKeySchema` / `SLOT_TO_MINUTES` は `time/` / `db/schema.ts` / 複数 feature が参照。

コメント区分では「3 層が同居する意味」を説明できず、ADR-0026 の cross-cutting 基準（複数 feature 参照の不変条件のみ）にも合致しない。

## Decision

- **`src/slot.ts` は pure domain のみ**（`SlotKey` / `SLOT_KEYS` / `slotKeySchema` / `SLOT_TO_MINUTES`）に縮小。依存ゼロ。
- **customId wire は `src/discord/shared/customId.ts` へ集約**（`CUSTOM_ID_SLOT_CHOICES` / `CustomIdSlotChoice` / `slotKeyFromCustomIdChoice` / `customIdChoiceFromSlotKey`）。`customId.ts` が custom_id 文字列 wire 情報の**単一所有者**。
- **DB wire 層は完全削除**: `DbSlotChoice` 型と 4 つの identity 変換（`SLOT_KEY_TO_DB_CHOICE` / `DB_CHOICE_TO_SLOT_KEY` / `slotKeyFromDbChoice` / `dbChoiceFromSlotKey`）。SlotKey を verbatim に DB 保存する事実を明示。ask の真の DB 列挙（ABSENT 含む 5 値）は `features/ask-session/choiceMap.ts` が所有。
- **`CHOICE_LABEL_FOR_RESPONSE`**（`ask-session/constants.ts`）は `dbChoiceFromSlotKey` 経由の構築をやめ `ASK_BUTTON_LABELS` spread + `ABSENT` literal に置換。
- **依存方向**: `customId.ts` → `slot.ts`（一方向）。

## Consequences

### Operational invariants & footguns
- DB 値としての SlotKey は verbatim 保存が正本。将来 DB 表現を変える際は `features/ask-session/choiceMap.ts` と schema を同時に触る必要がある（本物の変換境界）。`slot.ts` 側に identity alias / dead wrapper を再導入しない。

## Alternatives considered
- **ADR-0029 のまま据え置く** — コメント区分では DB wire が identity である理由を説明できず、規模に対して冗長のため却下。
- **DB wire を削除せず `features/ask-session/` に移設** — identity な dead ceremony を残しても価値がなく、削除の方が clean なため却下。
- **slot wire を `slot.ts` に残し customId.ts から import** — wire は custom_id 文字列の一部で cross-cutting domain ではなく、参照 1 箇所のため却下。
- **`src/time/slot.ts` に移動** — `SlotKey` は DB schema / UI label / customId wire にも使う cross-cutting 語彙で、time に閉じ込めると参照が汚くなるため却下。
