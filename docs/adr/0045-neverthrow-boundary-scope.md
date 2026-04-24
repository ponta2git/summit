---
adr: 0045
title: neverthrow の境界・orchestration 積極導入スコープ
status: accepted
date: 2026-04-25
supersedes: [0021]
superseded-by: null
tags: [runtime, discord, ops]
---

# ADR-0045: neverthrow の境界・orchestration 積極導入スコープ

## TL;DR

neverthrow は全面採用ではなく、Interaction handler pipeline と cross-feature orchestration の失敗分類に積極導入する。domain / repository / scheduler 内部は blanket conversion せず、業務結果・race-lost は state / discriminated return で表現し続ける。

## Context

ADR-0021 は neverthrow の適用を guards と button handler pipeline に限定した。しかし、その後の実装で `src/orchestration/` の一部は `ResultAsync` を返すようになり、Slash command も複数本へ増えた。

現在の力点は以下に変わっている。

- Interaction handler が複数 feature に広がり、boolean guard + try/catch と `AppResult` pipeline が混在している。
- Cross-feature orchestration は DB / Discord / outbox / feature UI 更新を順序駆動するため、失敗 source の分類が handler 境界で意味を持つ。
- 一方で repository の CAS race や domain decision は既に `undefined` / discriminated union で自然に表現されており、Result 化すると「正常な no-op」と「失敗」の区別が読みにくくなる。
- scheduler tick は `node-cron` / `runTickSafely` 境界で例外隔離する必要があり、全 tick を `ResultAsync` 化しても価値は限定的。

ADR-0021 の再評価トリガに到達したため、スコープを広げた新方針で置き換える。

## Decision

neverthrow の採用スコープを「application seam」へ広げる。

### Include

- **Interaction validation / handler pipeline**: cheap-first guard、custom_id / command options validation、DB read/write、Discord API 呼び出し、ユーザー向け失敗応答を 1 handler で合成する場合は `AppResult` / `ResultAsync` を使う。
- **Cross-feature orchestration**: `src/orchestration/` の exported flow が複数 feature / DB / Discord / outbox を順序駆動する場合は `ResultAsync<..., AppError>` を返す。
- **Boundary unwrap**: dispatcher / command handler / scheduler / startup recovery は `ResultAsync` を unwrap し、`AppError.code` と文脈識別子を構造化ログに含める。
- **Shared adapters**: DB / Discord Promise は `src/errors/result.ts` の adapter で `DatabaseError` / `DiscordApiError` に分類する。繰り返しが明確な場合のみ helper を増やす。

### Exclude

- **Pure domain**: decision evaluator / renderer / view model builder は discriminated union や plain value を維持する。
- **Repository / ports blanket conversion**: repository method は CAS race / no-op を `undefined` 等で返し、呼び出し側境界で `fromDatabasePromise` に包む。
- **Business outcome**: 中止・順延 NG・race-lost はエラーではなく状態遷移や正常な no-op として扱う。
- **Fail-fast invariant**: env / config parse、`assertNever`、repository の impossible state は throw を許容する。
- **Outbox worker internals**: retry / dead-letter は outbox state として表現し、entry 単位の Result 化は必須にしない。
- **Scheduler internals**: cron entry point は `Promise<void>` を維持し、Result-producing orchestration だけ境界で unwrap する。

## Consequences

### Follow-up obligations

- ADR-0021 を superseded にし、本 ADR を neverthrow scope の現行方針にする。
- `.github/instructions/runtime.instructions.md` に practical rule を追記する。
- 既存 Interaction handler の boolean guard / try-catch を、読みやすさが改善する箇所から `AppResult` / `ResultAsync` へ寄せる。
- `src/orchestration/` の exported flow は新規追加時に本 ADR の Include / Exclude を確認する。

### Operational invariants & footguns

- `ResultAsync` chain 内で race-lost を `Err` にしない。CAS `undefined` は別経路が先に収束した正常分岐として `Ok` に畳む。
- Discord API 失敗と DB 失敗は同じ catch に潰さず、adapter で `AppError.code` を分ける。
- Handler はユーザー向け応答のために Result を unwrap するが、DB 更新済みの Discord 失敗で DB を巻き戻さない。
- Result helper は「2 箇所以上で同じ unwrap / map が重複した時」に限り抽出し、ライブラリ都合の抽象化を増やさない。

## Alternatives considered

- **A: ADR-0021 維持** — 実装が既に orchestration ResultAsync へ進み、複数 Slash command の一貫性問題も出ているため現状に合わない。
- **B: neverthrow 全面採用** — repository / pure domain / scheduler internals まで Result 化すると、正常な state outcome と失敗の境界が曖昧になりテストも冗長になる。
- **C: try/catch へ回帰** — `AppError` 分類と既存 button pipeline の型駆動 guard を捨てるため、ADR-0015 の目的に反する。
- **D: effect-ts / fp-ts へ移行** — ADR-0017 と同じ理由で runtime 依存と学習曲線が過剰。

## Re-evaluation triggers

- repository port 境界で typed error を返さないと復旧方針を表現できない失敗種別が増えた時。
- scheduler が session 単位の部分失敗を集約し、後続処理へ型付きに伝搬する必要が出た時。
- neverthrow helper が増えすぎ、読みやすさより monadic plumbing が支配的になった時。

## Links

- @see ADR-0015
- @see ADR-0017
- @see ADR-0021
- @see ADR-0040
