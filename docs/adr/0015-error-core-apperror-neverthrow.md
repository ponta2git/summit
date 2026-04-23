---
adr: 0015
title: エラーコア（AppError 判別 union + neverthrow を境界で）
status: accepted
date: 2026-04-23
supersedes: []
superseded-by: null
tags: [runtime, ops]
---

# ADR-0015: エラーコア（AppError 判別 union + neverthrow を境界で）

## TL;DR
`src/errors.ts` に `AppError` 判別 union（`Auth` / `Validation` / `Conflict` / `DiscordApi` / `Db` / `State` / `Shutdown`）を定義し、`neverthrow` の `Result<T, AppError>` を境界層（dispatcher / scheduler tick / startup / shutdown）でのみ unwrap する。domain 内部は state 表現を維持。

## Context
エラー処理の水準が domain と infra でズレている。

- **業務エラーは state 表現で良好**: CAS race は `transitionStatus` が `undefined`、重複送信は `createAskSession` が `undefined` を返す等、discriminated return で機能している。
- **infra / invariant エラーは raw `throw`**: `settle.ts:21` / `ask/send.ts:52,116` / `db/repositories/sessions.ts:54,61,311` 等で `throw new Error(...)` が散在し、境界層で `unknown` catch に吸収されエラー種別がログ時点で失われる。
- **interaction イベントハンドラ（`interactions.ts:342-347`）は fire-and-forget** で top-level catch が無く、unhandled rejection リスクがある。
- **中央分類（AppError）も Result<T,E> adapter も不在**。kind 別運用（Auth → ephemeral reject / DiscordApi → 次 tick retry / Db → 停止 等）をログだけで判定している。

業務エラーの state 表現は維持しつつ、infra / invariant エラーを分類して境界層で扱うポリシーが必要。

## Decision
エラーコアを二層で設計する。

### AppError（判別 union）
`src/errors.ts` に kind 判別 union を定義: `Auth` / `Validation` / `Conflict` / `DiscordApi` / `Db` / `State` / `Shutdown`。各 variant は `{ kind, message, cause? }` 形状。@see `src/errors.ts`

### 境界 / domain の使い分け
- **境界層のみ `Result<T, AppError>` を unwrap**（dispatcher / scheduler tick / startup / shutdown）。`neverthrow` を依存追加し `fromThrowable` で既存 `throw` を Result 化、境界到達時点で kind 分類する。
- **domain 内部は state 表現を維持**（CAS race は `transitionStatus` が `undefined`、重複は `createAskSession` が `undefined` 等の discriminated return）。Result への変換は**境界層のみ**で、domain を書き換えない。

### Invariants
- `AppError.cause` に元 Error を保持し **pino redact** を通す（secret 混入防止）。
- 境界層最外周に `match` を置き kind 別に分岐（`Auth` → ephemeral reject / `DiscordApi` → 次 tick retry / `Db` → 起動停止 等）。`interactions.ts` の fire-and-forget も Result 化し unhandled rejection を境界で拾う。
- ルール詳細は `.github/instructions/runtime.instructions.md` に追記。

## Consequences

### Follow-up obligations
- dependencies に `neverthrow` を追加する。
- 既存 infra の raw `throw`（`settle.ts` / `ask/send.ts` / `db/repositories/sessions.ts` 等）を `fromThrowable` で Result 化し、境界層で kind 分類する。
- `interactions.ts` の fire-and-forget ハンドラを Result 化し、境界最外周 `match` で unhandled rejection を拾う。
- ルール詳細を `.github/instructions/runtime.instructions.md` に追記する。

### Operational invariants & footguns
- **domain は state 表現を維持、境界層のみで Result を unwrap**。domain を Result 化しない（`vi.mock` 時代の throw 戻りを招く footgun）。
- **`AppError.cause` は pino `redact` を通す**: secret 混入防止を前提に cause を保持する。redact 設定を緩めない。
- 境界層最外周の `match` kind 別分岐: `Auth` → ephemeral reject / `DiscordApi` → 次 tick retry / `Db` → 起動停止 等。分岐を追加する PR は ADR 更新を伴う。

## Alternatives considered

- **A: effect-ts** — 学習曲線と runtime 依存（Effect / Layer / Context）が 1500 LOC / 個人開発規模に対し過剰。
- **B: fp-ts** — 同上。Either / Task / TaskEither の型表現は強力だが本 Bot の境界数と頻度に対しオーバーエンジニアリング。
- **C: try/catch 継続（現状維持）** — 境界ポリシーが統一されず kind 別運用ができない。fire-and-forget の unhandled rejection リスクも残る。
- **D: 独自 Result 型を自作** — `neverthrow` の型精度（`Result<T, E>` narrow / `andThen` / `mapErr` / `match`）は成熟しており自作メンテコストに見合わない。
