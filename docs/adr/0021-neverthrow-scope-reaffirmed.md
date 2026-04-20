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

## Context
レビューで「neverthrow を全面採用してはどうか」という提案が出た。現状の採用範囲（ADR-0015）は:

- **境界で Result を使う**: Guards (`src/discord/guards.ts`) と button handler のパイプライン (`askButton.ts` / `postponeButton.ts`) は `AppResult` / `ResultAsync` で書かれている。
- **境界外は従来通り**: repositories / domain / scheduler / settle オーケストレータは async+throw / state+undefined を使う。
  - `transitionStatus` は race lost を `undefined` で表現。
  - scheduler tick は最外周 try/catch で吸収。
  - settle/* は早期 return によるフロー制御。

提案の検証対象:
1. `scheduler/*` tick を Result 化すべきか
2. `handleAskCommand` を Result 化すべきか（button handler と対称にする）
3. `settle/ask.ts` / `settle/postpone.ts` のオーケストレータを Result 化すべきか

## Decision
**全面採用を却下する**。ADR-0015 のスコープ（境界のみ）を維持する。個別の対象を以下のように判定した。

1. **scheduler tick**: **現状維持**（try/catch + logger.warn）。cron は fire-and-forget の最外周であり、エラーは次 tick で DB から再計算されて自己回復する。Result に変換しても `.match(noop, log)` という同型の記述に置き換わるだけで、LOC だけ増える。
2. **handleAskCommand**: **現状維持**（try/catch + `DiscordApiError` throw）。60 行の単発コマンドで、Result 化による型安全の増分は微小。button handler のパイプラインと違い、検証→DB→送信の逐次処理で分岐が少ない。
3. **settle/ask.ts / settle/postpone.ts**: **現状維持**（async + 早期 return）。これらは「race lost = `undefined` を観測したら何もせず返す」というパターンで書かれており、Drizzle の CAS primitive (`transitionStatus`) の return 値と直接噛み合う。Result 化するとこの流暢な制御フローを `.andThen(() => ok(undefined))` のような monadic chain に歪める必要があり、可読性が下がる。
4. **domain / repositories**: ADR-0015 通り **現状維持**（state-based）。domain は pure 関数、repository は CAS で `undefined` を返す。

## Consequences
### 得られるもの
- **型システムを活用すべき場所は引き続き活用**: Guard と button handler のパイプラインは `AppResult` と `GUARD_REASON_TO_MESSAGE` の exhaustive record で型駆動の拒否処理を維持。
- **LOC 最小化**: プロジェクト規模 (~2400 LOC) に対し、Result 化の拡大は 15-25% LOC 増を伴う。収穫逓減領域。
- **概念的な整理**: 「どこが境界か」を明確にすることで、将来のコードレビューで「ここは Result にすべきか？」の判断が早くなる。

### 失うもの / 運用上の含意
- **一貫性の欠如**: ボタン handler とコマンド handler で Result / throw が混在する。Slash command が今後増えた場合、パイプライン化が必要なレベルまで複雑化した時点で個別に Result 化を検討する（再評価条件）。
- **境界判定は都度レビュー**: 「境界」の定義を文章で残しているが、コードだけでは自明でないため、新規 handler 追加時に当 ADR を参照する必要がある。

### 再評価条件
以下のいずれかを満たした場合、本 ADR の再評価（supersede）を行う:
- Slash command が 3 本以上になり、共通検証パイプラインが必要になった時。
- settle/* の orchestrator が複数のエラー source（DB 失敗 / Discord 失敗 / domain 不整合）を区別して振る舞う必要が出た時。
- scheduler tick が複数の副作用を持ち、部分失敗の伝搬を型で追跡したくなった時。

## Alternatives considered
- **全面採用（提案のまま）**: scheduler / handleAskCommand / settle/* すべてを Result 化する案。LOC 膨張と既存の読みやすい早期 return フローの破壊を招くため却下。
- **handleAskCommand だけ Result 化**: button との対称性は得られるが、他のコマンドが無い現状で 1 ファイル単独の対称化は「一貫性のための一貫性」。再評価条件が揃ったタイミングで対応する。
- **fp-ts / effect-ts などの代替 monad ライブラリ導入**: ADR-0017 で既に却下済み。本 ADR でも踏襲。
