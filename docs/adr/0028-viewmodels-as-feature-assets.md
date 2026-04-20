---
adr: 0028
title: viewModel の feature 所有と discord/shared の真 cross-cutting 化
status: accepted
date: 2026-04-25
supersedes: []
superseded-by: null
tags: [runtime, discord, docs]
---

# ADR-0028: viewModel の feature 所有と discord/shared の真 cross-cutting 化

## Context

ADR-0027 で UI 資産（constants / messages）を feature 同梱にしたあと、`src/discord/shared/` に残る 3 ファイルを再評価した。

- `guards.ts` (227 LOC): dispatcher が呼ぶ cheap-first 検証 + guard reason → reject message 対応表。**全 interaction 入口**が通る。真の cross-cutting。
- `channels.ts` (30 LOC): `getTextChannel`（Discord SDK 薄ラッパ）+ `CancelReason` 型 + `renderSettleNotice`。3 役混在。
- `viewModels.ts` (276 LOC): `ViewModelMemberInput/ResponseInput/SessionInput`（構造 DTO）+ feature 別 ViewModel 型 5 種 + builder。consumer を追うと **ほぼ各 builder は 1 feature にしか使われていない**（例外: `buildPostponeMessageViewModel` は postpone-voting と ask-session/settle の 2 箇所）。

viewModel builder と ViewModel 型は「そのメッセージを誰が描くか」と等価であり feature が所有すべき。`renderSettleNotice` も ask-session/settle のみから呼ばれる。`CancelReason` は ask-session/settle のキャンセル理由語彙（cancel-week/settle は `"manual_skip"` を DB 直書きで別体系）。

## Decision

1. **ViewModel を feature 所有に分解**:
   - `src/features/ask-session/viewModel.ts` — `AskMessageViewModel` / `SettleNoticeViewModel` / `buildAskMessageViewModel` / `buildInitialAskMessageViewModel` / `buildSettleNoticeViewModel` / `renderSettleNotice`
   - `src/features/postpone-voting/viewModel.ts` — `PostponeMessageViewModel` / `PostponeMemberStatus` / `buildPostponeMessageViewModel`
   - `src/features/decided-announcement/viewModel.ts` — `DecidedAnnouncementViewModel` / `buildDecidedAnnouncementViewModel`

2. **構造 DTO のみ shared に残す**:
   - `src/discord/shared/viewModelInputs.ts` — `ViewModelMemberInput` / `ViewModelResponseInput` / `ViewModelSessionInput`（DB 行型と UI ビルダーを decouple する契約。全 VM が共用）。

3. **`CancelReason` を ask-session 内に格下げ**:
   - `src/features/ask-session/cancelReason.ts` — ask-session の settle 専用。cancel-week は別語彙（`"manual_skip"`）なので shared 格納は過剰抽象だった。

4. **`channels.ts` を `getTextChannel` のみに限定**:
   - `renderSettleNotice` は ask-session/viewModel.ts へ移設。
   - `channels.ts` は Discord SDK 薄ラッパ 1 関数のみ（7 行）。

5. **`ask-session/settle.ts` → `postpone-voting/viewModel.ts` の feature 間 import を許容**:
   - 初回の順延投票投稿を ask-session が作成する既存設計に由来（ADR-0019）。
   - 許容するのは **pure な型 + builder** に限定。state / side-effect / ports を含むモジュールの feature 間 import は引き続き禁止（ADR-0025 / ADR-0026）。

## Consequences

- `src/discord/shared/` の 5 ファイル（`dispatcher.ts` / `guards.ts` / `customId.ts` / `channels.ts` / `viewModelInputs.ts`）はすべて「interaction 入口 / 出口 / DB decouple 契約」のどれかで、例外なく全 feature が通る or 共有する構造になる。「shared」の意味が**定義**になる。
- feature ディレクトリが `messages.ts` / `constants.ts` / `viewModel.ts` / `render.ts` / `button.ts` / `command.ts` / `send.ts` / `settle.ts` / `messageEditor.ts` の 1 揃いになり、1 feature = 1 ディレクトリで自給自足（ADR-0025 の完成形）。
- 過渡期コスト: 15 ファイルの import 書き換え。`tests/discord/viewModels.test.ts` は cross-feature の VM 形状契約テストとして同名で残す（4 describe ブロックが各 feature の builder を検証）。
- 将来: VM test を feature ごとに分解するかは任意（コストに対する効果が薄いため現時点では保留）。

## Alternatives considered

- **viewModels.ts をそのまま shared に残す**: 棄却。276 LOC の大半が feature 所有物で、ownership が曖昧。新 feature 追加のたびに「shared に書くか feature に書くか」を毎回判断する羽目になる。
- **構造 DTO も feature 内に置く**: 棄却。`ViewModelMemberInput` 等は全 VM が共通に依存する decouple 契約で、特定 feature に所有させると別 feature が別 feature を import する理由が増える。
- **`CancelReason` を shared に残す**: 棄却。cancel-week は `manual_skip` を DB に直書きで別語彙。cross-feature に見えた語彙は**実際には ask-session 固有**だった。
- **`renderSettleNotice` を shared に残す**: 棄却。呼び出すのは ask-session/settle のみ。settle notice は ask-session 完結の副次投稿。
- **ViewModel builder を現状の shared から呼び出し続ける**: 棄却。feature が自分の描画を他所に預ける非対称を生み、grep と変更の追跡コストが増える。

## References

- `src/features/ask-session/{viewModel.ts, cancelReason.ts}`
- `src/features/postpone-voting/viewModel.ts`
- `src/features/decided-announcement/viewModel.ts`
- `src/discord/shared/{viewModelInputs.ts, channels.ts}`
- ADR-0014, ADR-0019, ADR-0025, ADR-0026, ADR-0027
