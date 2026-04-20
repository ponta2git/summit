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

## Context

ADR-0025（features/ 再編）および ADR-0026（境界再整理）後も、UI 資産（ボタンラベル・色・ユーザー可視文字列）が feature 外に残っていた。

- `src/constants.ts`（52 LOC）: ask/postpone ボタンの label / style / choice→label の UI cosmetic 定数を集約。
- `src/messages.ts`（273 LOC）: ask / settle / reminder / decided / postpone / interaction など全 feature の Japanese 文言を 1 つの `messages` object に集約。
- `src/discord/shared/messages.ts`（97 LOC）: `getTextChannel` / `renderSettleNotice`（cross-feature）と `updateAskMessage` / `updatePostponeMessage`（feature 固有）が同居。
- `src/members.ts`（flat）と `src/members/`（dir）が並存。
- `docs/architecture.md` の依存図も `messages.ts` / `constants.ts` が SSoT の末端に居残る記述。

feature をオーナーシップ単位として実装するなら UI 文言・UI cosmetic 定数・メッセージ編集関数は feature 内に同居する方が自然で、grep も短く収束する。

## Decision

1. **UI cosmetic 定数を feature 同梱**: `src/constants.ts` を廃止し `src/features/ask-session/constants.ts` / `src/features/postpone-voting/constants.ts` に分割。
2. **ユーザー可視メッセージを feature 同梱**: `src/messages.ts` を廃止し、feature ごとに `src/features/<feat>/messages.ts` を置く（`askMessages` / `postponeMessages` / `reminderMessages` / `decidedMessages` / `cancelWeekMessages`）。
3. **拒否系 / システムメッセージを shared**: interaction.reject / unknownCommand / staleButton / internalError は cross-cutting なので `src/discord/shared/rejectMessages.ts` に集約。
4. **feature 固有の message editor を feature 内に移設**: `updateAskMessage` → `src/features/ask-session/messageEditor.ts`、`updatePostponeMessage` → `src/features/postpone-voting/messageEditor.ts`。
5. **`discord/shared` は cross-cutting に限定**: `src/discord/shared/messages.ts` を `channels.ts` にリネームし `getTextChannel` / `CancelReason` / `renderSettleNotice` のみ残す。
6. **members を dir に統合**: `src/members.ts` → `src/members/inputs.ts`（`git mv` で履歴保持）。
7. **logger/env の `util/` 化は採用しない**: 29 / 79 LOC、SSoT として `src/env.ts` / `src/logger.ts` を `.github/instructions/*` から直接参照している。`util/` は「雑多な助け」の語感が強く、SSoT を曖昧化するため移設しない。

## Consequences

- feature ディレクトリが「その feature の言語的・視覚的・構造的表現をすべて含む」単位になり、変更時の grep 範囲が feature 内に閉じる。
- `discord/shared/` の責務が「cross-cutting な infrastructure / 拒否テキスト / チャンネル取得」に収束し、feature 特有のものが混ざらない。
- `src/` 直下のフラットファイルが減り、SSoT 候補（`env.ts` / `config.ts` / `slot.ts` / `logger.ts`）が「本当に全モジュール横断で 1 つの事実」に限定される。
- ADR-0013 の「`src/constants.ts` / `src/messages.ts` SSoT」記述はパス上無効化される。ADR 自体は immutable のため書き換えず、本 ADR で置換関係を明示する（ADR-0013 の階層思想は引き続き有効、ファイル配置のみ本 ADR で更新）。
- 過渡期コスト: 消費側 import 約 18 ファイルの書き換え（一括実施）。既存テストは振る舞いを変えずに名前空間だけ `askMessages` / `postponeMessages` 等へ移行。

## Alternatives considered

- **UI 定数・文言を `src/` フラットに残し続ける**: 棄却。feature ownership が曖昧で、新 feature 追加時に「どこに文言を足すか」が常に判断事項になる。
- **`util/` ディレクトリに logger/env を移す**: 棄却。29 LOC / 79 LOC のファイルを `util/` に沈めても SSoT は増えず、むしろ「util に何があるか」を grep する手間が増える。`.github/instructions/*` からは `src/env.ts` / `src/logger.ts` を直接ポイントしており、パス変更は drift 源。
- **`discord/shared/messages.ts` をそのまま維持**: 棄却。`getTextChannel`（infra）と `updateAskMessage`（ask 固有）が同居する状態は feature ownership を弱める。
- **members の flat ファイルを残し `src/members/` を `src/member-reconcile/` に改名**: 棄却。`members` という業務語彙（ADR-0014 命名辞書）を保ったまま物理統合するほうが読み手の負荷が低い。

## References

- `src/features/<feat>/messages.ts`（ask-session / postpone-voting / reminder / decided-announcement / cancel-week）
- `src/features/<feat>/constants.ts`（ask-session / postpone-voting）
- `src/features/ask-session/messageEditor.ts`, `src/features/postpone-voting/messageEditor.ts`
- `src/discord/shared/channels.ts`, `src/discord/shared/rejectMessages.ts`
- `src/members/inputs.ts`, `src/members/reconcile.ts`
- ADR-0013, ADR-0014, ADR-0022, ADR-0025, ADR-0026
