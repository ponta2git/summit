---
adr: 0021
title: neverthrow 全面採用の却下とスコープ再確認
status: accepted
date: 2026-04-24
supersedes: []
superseded-by: null
tags: [runtime, ops]
---

# ADR-0021: neverthrow 全面採用の却下とスコープ再確認

## TL;DR
neverthrow の全面採用を却下し、ADR-0015 のスコープ（Guards と button handler パイプラインのみ Result 化）を維持する。scheduler tick / `handleAskCommand` / settle/* は現状の try/catch + 早期 return を維持。再評価トリガ: slash command 3 本以上 / settle の複数エラー source 区別 / scheduler の部分失敗伝搬が必要になった時。

## Context
レビューで「neverthrow を全面採用してはどうか」という提案が出た。現状は ADR-0015 により境界のみ Result 化されている:

- **境界（Result）**: Guards (`src/discord/guards.ts`) と button handler パイプライン (`askButton.ts` / `postponeButton.ts`)。
- **境界外（throw / state + undefined）**: repositories / domain / scheduler / settle。`transitionStatus` は race lost を `undefined` で表現、scheduler tick は最外周 try/catch、settle/* は早期 return。

拡大候補として検証が必要な対象: `scheduler/*` tick / `handleAskCommand` / `settle/ask.ts` / `settle/postpone.ts` オーケストレータ。

## Decision
**全面採用を却下**。ADR-0015 のスコープ（境界のみ Result 化）を維持する。

### 対象別判定（すべて現状維持）
| 対象 | 判定 | 根拠 |
|---|---|---|
| **scheduler tick** | try/catch + `logger.warn` | fire-and-forget、次 tick で DB から自己回復。Result 化は `.match(noop, log)` と等価で LOC のみ増 |
| **handleAskCommand** | try/catch + `DiscordApiError` throw | 単発・逐次処理、分岐少。button handler と違い pipeline 不要 |
| **settle/ask.ts・settle/postpone.ts** | async + 早期 return | 「race lost = `undefined` を観測 → no-op return」が `transitionStatus` CAS と直接噛み合う。monadic chain 化で可読性が落ちる |
| **domain / repositories** | state-based（ADR-0015 通り） | pure 関数 / CAS で `undefined` |

### Invariants
- **境界の定義**: Guards (`src/discord/guards.ts`) と button handler パイプライン（`askButton.ts` / `postponeButton.ts`）のみ `AppResult` / `ResultAsync` を使う。
- **混在は意図的**。新規 handler 追加時は本 ADR を参照し、再評価条件を満たすまで拡大しない。

### 再評価トリガ（いずれかで supersede 検討）
- Slash command が **3 本以上**になり共通検証 pipeline が必要になった時
- settle/\* の orchestrator が**複数のエラー source**（DB / Discord / domain 不整合）を区別する必要が出た時
- scheduler tick が**部分失敗の伝搬**を型で追跡する必要が出た時

## Consequences

### Follow-up obligations
- **一貫性の欠如**: ボタン handler とコマンド handler で Result / throw が混在する。Slash command が今後増えた場合、パイプライン化が必要なレベルまで複雑化した時点で個別に Result 化を検討する（再評価条件）。
- 以下のいずれかを満たした場合、本 ADR の再評価（supersede）を行う:
  - Slash command が 3 本以上になり、共通検証パイプラインが必要になった時。
  - settle/* の orchestrator が複数のエラー source（DB 失敗 / Discord 失敗 / domain 不整合）を区別して振る舞う必要が出た時。
  - scheduler tick が複数の副作用を持ち、部分失敗の伝搬を型で追跡したくなった時。

### Operational invariants & footguns
- **型システムを活用すべき場所は引き続き活用**: Guard と button handler のパイプラインは `AppResult` と `GUARD_REASON_TO_MESSAGE` の exhaustive record で型駆動の拒否処理を維持。
- **LOC 最小化**: プロジェクト規模 (~2400 LOC) に対し、Result 化の拡大は 15-25% LOC 増を伴う。収穫逓減領域。
- **概念的な整理**: 「どこが境界か」を明確にすることで、将来のコードレビューで「ここは Result にすべきか？」の判断が早くなる。
- **境界判定は都度レビュー**: 「境界」の定義を文章で残しているが、コードだけでは自明でないため、新規 handler 追加時に当 ADR を参照する必要がある。

## Alternatives considered
- **全面採用（scheduler / handleAskCommand / settle/\* すべて Result 化）** — LOC 膨張と既存の読みやすい早期 return フローの破壊を招くため却下。
- **handleAskCommand だけ Result 化** — 他コマンドが無い現状では 1 ファイル単独の対称化は「一貫性のための一貫性」。再評価条件が揃うまで保留。
- **fp-ts / effect-ts など代替 monad ライブラリ導入** — ADR-0017 で却下済み、本 ADR でも踏襲。
