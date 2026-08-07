---
adr: 0053
title: scheduler application seam への neverthrow 適用拡大
status: accepted
date: 2026-08-08
supersedes: [0045]
superseded-by: null
tags: [runtime, ops, discord, testing]
---

# ADR-0053: scheduler application seam への neverthrow 適用拡大

## TL;DR

`src/scheduler/` の I/O を順序駆動する scheduler operation と recovery orchestration は `ResultAsync<..., AppError>` を返す。cron、timer、outbox の状態機械は runtime adapter と state return を維持し、scheduler 全体を blanket conversion しない。

## Context

ADR-0045 は interaction pipeline と cross-feature orchestration を neverthrow の中心範囲とし、scheduler internals を除外していた。その後、scheduler の deadline、startup recovery、reconciler、supervisor は複数の DB / Discord operation を順序駆動し、現在は一部だけが `ResultAsync`、残りが raw throw / local catch / zero-value fallback という混在になっている。

この混在では、scheduler の境界で DB failure と Discord failure を分類できず、session 単位の部分失敗も型で追跡できない。一方、CAS race、retry、dead-letter、dedupe skip は業務状態であり、エラーとして扱ってはならない。

## Decision

- scheduler の業務 operation、startup recovery、reconciler、supervisor、metrics / retention の I/O 境界は `ResultAsync<..., AppError>` を返す。
- session / entry 単位の recoverable failure は report に蓄積して後続処理を継続する。phase 全体の query failure は `Err` として上位へ伝播する。
- cron / timer callback は `Promise<void>` の runtime adapter で `ResultAsync` を unwrap する。
- timer mechanics、pure function、repository / ports、outbox entry の retry / dead-letter、CAS race / claim lost は blanket conversion の対象外とする。
- DB / Discord の Promise は `src/errors/result.ts` の adapter で分類する。同期 throw の可能性がある function は function-based adapter を使用する。
- `AppError.code` をエラー分類の正本とし、`cause` は既存の logger redact 前提で保持する。

## Consequences

- scheduler operation の public return type とその全 caller / test を同時に更新する必要がある。
- `updateAskMessage` など、現在 feature 内で I/O failure を吸収している関数は、Result boundary が機能するよう failure ownership を orchestration 側へ移す。
- batch report の failure は二重ログしない。leaf は state success / operational log、boundary は typed failure を担当する。
- `runTickSafely` の process isolation と scheduler の単一インスタンス、JST、DB-as-SoT、outbox ordering は不変とする。

## Alternatives considered

- **scheduler 全体を ResultAsync 化** — timer mechanics、state machine、race outcome まで error に見えて境界が壊れる。
- **既存の try/catch と zero-value fallback を維持** — failure source と部分失敗を型で追跡できない。
- **batch を全て short-circuit chain にする** — 1 session の失敗で後続 session が止まり、既存の recovery semantics を壊す。

## Re-evaluation triggers

- scheduler report の helper が業務コードより大きくなった場合。
- outbox state と typed failure の境界が新しい運用要件で不足した場合。
- scheduler operation の failure policy が phase ごとに複雑化し、専用 workflow 層が必要になった場合。

## Links

- @see ADR-0015
- @see ADR-0040
- @see ADR-0047
- @see ADR-0051
- @see src/scheduler/
