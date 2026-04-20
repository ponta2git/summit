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

## Context
ADR-0029 では `src/slot.ts` の内部境界を「domain / customId wire / DB wire」の 3 section にコメントで区分し、`customId.ts` との責務差をヘッダコメントで文書化した。

しかしその直後のレビューで、コメントだけでは不十分と指摘された。実装を見直すと以下が判明:

1. **DB wire section は完全な identity**: `DbSlotChoice` は `SlotKey` の type alias、`SLOT_KEY_TO_DB_CHOICE` / `DB_CHOICE_TO_SLOT_KEY` は identity object、`slotKeyFromDbChoice` / `dbChoiceFromSlotKey` は identity 関数。DB は SlotKey 文字列を verbatim に保存しており、変換層が存在する理由がない。真の「ask の DB 列挙」は ABSENT を含む 5 値で、これは `features/ask-session/choiceMap.ts` が所有している。つまり `slot.ts` の DB wire は本物の DB 境界ではなく、dead ceremony。
2. **customId wire の consumer は 2 箇所のみ**: `discord/shared/customId.ts` が `CUSTOM_ID_SLOT_CHOICES` を import し、`features/ask-session/render.ts` が `slotKeyFromCustomIdChoice` を import するだけ。どちらも custom_id 文字列を扱う文脈であり、`customId.ts` に同居させるのが自然。
3. **pure domain（SlotKey / SLOT_KEYS / slotKeySchema / SLOT_TO_MINUTES）は広範に使われる**: `time/`, `db/schema.ts`, 複数 feature が参照する真の cross-cutting domain。

コメント区分はこれら 3 層が「同じファイルに同居する意味」を説明できておらず、ADR-0026 の cross-cutting 基準（複数 feature が参照する不変条件のみ）にも合致しない。

## Decision
- `src/slot.ts` を **pure domain のみ**に縮小する: `SlotKey` / `SLOT_KEYS` / `slotKeySchema` / `SLOT_TO_MINUTES` だけを置く。
- customId wire（`CUSTOM_ID_SLOT_CHOICES` / `CustomIdSlotChoice` / `slotKeyFromCustomIdChoice` / `customIdChoiceFromSlotKey`）を `src/discord/shared/customId.ts` に移設し、そこを唯一の所有者とする。`customId.ts` は「custom_id 文字列の parse/build に必要なすべての wire 情報」を持つ単一ファイルになる。
- DB wire 層（`DbSlotChoice` 型および 4 つの変換関数/マップ）は **完全削除**する。SlotKey をそのまま DB 値として扱う。
- `ask-session/constants.ts` の `CHOICE_LABEL_FOR_RESPONSE` は `dbChoiceFromSlotKey(...)` 経由の構築をやめ、`ASK_BUTTON_LABELS` の spread + `ABSENT` literal に置き換える。
- 依存方向: `customId.ts` → `slot.ts` のみ。`slot.ts` は依存ゼロ。

## Consequences
- `slot.ts` は ~20 行の pure domain module となり、ファイル名と中身が完全一致する。
- 「slot の wire 表現」を知りたければ `customId.ts` を開けば良い、という直感的な導線が得られる。
- dead code（identity alias / mapping / 関数）が削除され、実装の意図と実体が一致する。
- DB 層が SlotKey を verbatim に扱う事実が明示され、将来 DB 値を変えたくなった場合は `features/ask-session/choiceMap.ts` と schema を同時に触ることになり、本物の変換境界と dead wrapper の混同が起きない。
- ADR-0029 の Decision 4（slot.ts / customId.ts の境界をコメントで文書化）は本 ADR で補強される（破棄ではなく、コメント + 責務再分割の両方を満たす形）。

## Alternatives considered
- **ADR-0029 のまま据え置く**: コメント区分は読み手に「なぜ DB wire が identity なのか」を説明できず、規模に対して冗長。却下。
- **DB wire を消さず `features/ask-session/` に移設**: DB wire は存在自体が dead ceremony（identity）なので、移設しても何の value も生まれない。削除の方が clean。
- **slot wire を `slot.ts` に残し customId.ts から import したまま**: wire 表現は custom_id 文字列の一部でしかなく、cross-cutting domain ではない。参照 1 箇所の wire を cross-cutting domain に置くのは責務漏れ。却下。
- **`src/time/slot.ts` に移動**: `SLOT_TO_MINUTES` は time 計算に使うが、`SlotKey` は DB schema / UI label / customId wire など time 以外にも広く使う cross-cutting vocabulary。time に閉じ込めると逆に参照が汚くなる。却下。
