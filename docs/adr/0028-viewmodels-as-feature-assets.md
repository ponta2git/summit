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

## TL;DR
ViewModel builder と ViewModel 型は描画する feature が所有する（`src/features/<feat>/viewModel.ts`）。構造 DTO（`ViewModelMemberInput` 等の DB 行 decouple 契約）のみ `src/discord/shared/viewModelInputs.ts` に残す。`CancelReason` は ask-session 固有と判明したため feature 配下へ格下げ。`channels.ts` は `getTextChannel` 7 行のみに縮小。

## Context

ADR-0027 で UI 資産を feature 同梱にした follow-through。`src/discord/shared/` 残 3 ファイルの ownership を consumer ベースで再評価した結果、以下の non-uniform さが判明:

- `guards.ts`: 全 interaction 入口が通る cheap-first 検証。真の cross-cutting。
- `channels.ts`: `getTextChannel`（SDK 薄ラッパ）/ `CancelReason` 型 / `renderSettleNotice` が混在。後 2 者は ask-session/settle からのみ呼ばれる。
- `viewModels.ts`: builder の大半が 1 feature 限定（例外: `buildPostponeMessageViewModel` が postpone-voting + ask-session/settle の 2 箇所）。一方 `ViewModelMemberInput/ResponseInput/SessionInput` は DB 行と UI を decouple する全 VM 共通契約。

つまり「描画ロジック」は feature 固有で、「DB 行 decouple DTO」だけが真の cross-cutting 契約。`CancelReason` も cancel-week が `"manual_skip"` を直書きする別語彙であり、実態は ask-session 固有。

## Decision

### Ownership

- **ViewModel 型 + builder は描画する feature が所有**。`@see src/features/{ask-session,postpone-voting,decided-announcement}/viewModel.ts`。
- **構造 DTO のみ shared**: `ViewModelMemberInput` / `ResponseInput` / `SessionInput`（DB 行と UI を decouple する全 VM 共通契約）。`@see src/discord/shared/viewModelInputs.ts`。
- **`CancelReason` は ask-session 固有**（cancel-week は `"manual_skip"` を直書きする別語彙）。`@see src/features/ask-session/cancelReason.ts`。
- **`channels.ts` は `getTextChannel` のみ**（Discord SDK 薄ラッパ）。`renderSettleNotice` は ask-session/viewModel.ts へ移設。

### Cross-feature import rule

- `ask-session/settle.ts` → `postpone-voting/viewModel.ts` の import は**許容**（ADR-0019 由来: 初回順延投票投稿を ask-session が作成）。
- 許容は **pure 型 + builder のみ**。state / side-effect / ports を含むモジュールの feature 間 import は**禁止**（ADR-0025 / ADR-0026）。

## Consequences

### Follow-up obligations
- import 書き換え ~15 サイトは本 ADR の適用 PR 内で完了させる。段階移行を残さない。
- `tests/discord/viewModels.test.ts` は cross-feature の VM 形状契約テストとして同名維持。feature ごとへの分解はコストに対し効果が薄く現時点では保留（必要になった段階で再評価）。

### Operational invariants & footguns
- `src/discord/shared/` への追加は「interaction 入口 / 出口 / DB decouple 契約」のいずれかに限定する。feature 固有のロジックを shared に落とすと「shared」の定義が崩れる。

## Alternatives considered

- **viewModels.ts を shared に残す** — 大半が feature 所有物で ownership が曖昧になり、追加のたびに配置判断を要するため却下。
- **構造 DTO も feature 内に置く** — `ViewModelMemberInput` 等は全 VM 共通の decouple 契約で、特定 feature に所有させると feature 間 import を誘発するため却下。
- **`CancelReason` を shared に残す** — cancel-week は `manual_skip` を直書きする別語彙で、実際は ask-session 固有語彙だったため却下。
- **`renderSettleNotice` を shared に残す** — 呼び出しは ask-session/settle のみで、settle notice は ask-session 完結の副次投稿のため却下。
- **ViewModel builder を shared から呼び出し続ける** — feature が描画を他所に預ける非対称となり grep/追跡コストが増えるため却下。

## References

- `src/features/ask-session/{viewModel.ts, cancelReason.ts}`
- `src/features/postpone-voting/viewModel.ts`
- `src/features/decided-announcement/viewModel.ts`
- `src/discord/shared/{viewModelInputs.ts, channels.ts}`
- ADR-0014, ADR-0019, ADR-0025, ADR-0026, ADR-0027
