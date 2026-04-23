---
adr: 0027
title: UI 資産の feature 同梱と discord/shared の境界明確化
status: accepted
date: 2026-04-25
supersedes: []
superseded-by: null
tags: [runtime, discord, docs]
---

# ADR-0027: UI 資産の feature 同梱と discord/shared の境界明確化

## TL;DR
`src/constants.ts` / `src/messages.ts` を廃止し、UI cosmetic 定数とユーザー可視文言を各 feature の `constants.ts` / `messages.ts` に分割する。feature 固有の message editor（`updateAskMessage` 等）も feature 配下へ移設。`src/discord/shared/` は真の cross-cutting（dispatcher / guards / customId / channels / 拒否テキスト）だけに限定。

## Context
ADR-0025（features/ 再編）と ADR-0026（境界再整理）後も UI 資産（ボタンラベル・色・ユーザー可視文字列）が feature 外に残り、feature ownership の単位が中途半端だった（LOC・パスは driver として保持）:

- `src/constants.ts`（52 LOC）: ask/postpone ボタンの label / style / choice→label を集約。
- `src/messages.ts`（273 LOC）: 全 feature の日本語文言を単一 `messages` object に集約。
- `src/discord/shared/messages.ts`（97 LOC）: cross-feature な `getTextChannel` / `renderSettleNotice` と feature 固有 `updateAskMessage` / `updatePostponeMessage` が同居。
- `src/members.ts`（flat）と `src/members/`（dir）が並存。
- `docs/architecture.md` の依存図も旧 SSoT を反映した末端記述が残存。

feature をオーナーシップ単位とするなら UI 文言・cosmetic 定数・メッセージ編集関数は feature 内に同居する方が自然で、grep 範囲も収束する。

## Decision

### 構造変更
1. **UI cosmetic 定数を feature 同梱**: `src/constants.ts` を廃止 → `src/features/ask-session/constants.ts` / `src/features/postpone-voting/constants.ts`。
2. **ユーザー可視メッセージを feature 同梱**: `src/messages.ts` を廃止 → `src/features/<feat>/messages.ts`（`askMessages` / `postponeMessages` / `reminderMessages` / `decidedMessages` / `cancelWeekMessages`）。
3. **拒否系 / システムメッセージも feature 化**: interaction.reject / unknownCommand / staleButton / internalError → **`src/features/interaction-reject/messages.ts`**（dispatcher / guards / feature command が参照）。
4. **feature 固有の message editor を feature 内へ**: `updateAskMessage` → `src/features/ask-session/messageEditor.ts`、`updatePostponeMessage` → `src/features/postpone-voting/messageEditor.ts`。
5. **`discord/shared` は cross-cutting に限定**: `src/discord/shared/messages.ts` → **`channels.ts`** にリネームし `getTextChannel` / `CancelReason` / `renderSettleNotice` のみ残す。
6. **members を dir に統合**: `src/members.ts` → `src/members/inputs.ts`（`git mv` で履歴保持）。

### 不採用
- **logger/env の `util/` 化は採用しない**: `src/env.ts` / `src/logger.ts` は `.github/instructions/*` から直接参照されている SSoT。`util/` は語感が曖昧で SSoT を弱める。

### Invariants
- feature ディレクトリが「その feature の**言語的・視覚的・構造的表現をすべて含む**」単位となり、変更時の grep 範囲が feature 内に閉じる。
- `src/discord/shared/` の責務は「cross-cutting infrastructure / 拒否テキスト / チャンネル取得」に限定。feature 特有のものを混ぜない。
- `src/` 直下のフラットファイルは真に横断する SSoT（`env.ts` / `config.ts` / `slot.ts` / `logger.ts` 等）に限定。
- ADR-0013 の「`src/constants.ts` / `src/messages.ts` SSoT」記述はパス上無効化（階層思想は維持）。ADR-0013 は immutable、本 ADR で置換関係を明示。

## Consequences

### Follow-up obligations
- 過渡期コスト: 消費側 import 約 18 ファイルの書き換え（一括実施）。既存テストは振る舞いを変えずに名前空間だけ `askMessages` / `postponeMessages` 等へ移行。

### Operational invariants & footguns
- feature ディレクトリが「その feature の言語的・視覚的・構造的表現をすべて含む」単位になり、変更時の grep 範囲が feature 内に閉じる。
- `discord/shared/` の責務が「cross-cutting な infrastructure / 拒否テキスト / チャンネル取得」に収束し、feature 特有のものが混ざらない。
- `src/` 直下のフラットファイルが減り、SSoT 候補（`env.ts` / `config.ts` / `slot.ts` / `logger.ts`）が「本当に全モジュール横断で 1 つの事実」に限定される。
- ADR-0013 の「`src/constants.ts` / `src/messages.ts` SSoT」記述はパス上無効化される。ADR 自体は immutable のため書き換えず、本 ADR で置換関係を明示する（ADR-0013 の階層思想は引き続き有効、ファイル配置のみ本 ADR で更新）。

## Alternatives considered

- **UI 定数・文言を `src/` フラットに残す** — feature ownership が曖昧で、新 feature 追加時に文言配置が常に判断事項になるため棄却。
- **`util/` ディレクトリに logger / env を移す** — 小サイズファイルを util に沈めても SSoT は増えず grep 手間が増加、instructions からの直接ポインタも drift 源になるため棄却。
- **`discord/shared/messages.ts` をそのまま維持** — infra と ask 固有 helper が同居し feature ownership を弱めるため棄却。
- **members flat ファイルを残し `src/members/` を `src/member-reconcile/` に改名** — 業務語彙 `members`（ADR-0014）を保ったまま物理統合する方が読み手負荷が低いため棄却。

## References

- `src/features/<feat>/messages.ts`（ask-session / postpone-voting / reminder / decided-announcement / cancel-week / interaction-reject）
- `src/features/<feat>/constants.ts`（ask-session / postpone-voting）
- `src/features/ask-session/messageEditor.ts`, `src/features/postpone-voting/messageEditor.ts`
- `src/discord/shared/channels.ts`, `src/features/interaction-reject/messages.ts`
- `src/members/inputs.ts`, `src/members/reconcile.ts`
- ADR-0013, ADR-0014, ADR-0022, ADR-0025, ADR-0026
