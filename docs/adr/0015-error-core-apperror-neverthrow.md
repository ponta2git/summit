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

## Context
エラー処理の現状は domain と infra で水準がズレている。

- **業務エラーは state で良好に表現されている**: CAS race は `transitionStatus` が `undefined` を返す、重複送信は `createAskSession` が `undefined` を返す、など discriminated return を使った設計が機能している。
- **infra / invariant エラーは raw `throw`**: `settle.ts:21` / `ask/send.ts:52,116` / `db/repositories/sessions.ts:54,61,311` 等で `throw new Error(...)` が散在し、境界層で `unknown` catch に吸収される。エラー種別の分類がログ時点で失われる。
- **interaction イベントハンドラ（`interactions.ts:342-347`）は fire-and-forget**。top-level catch が無く、unhandled rejection のリスクがある。
- **中央分類（AppError）も Result<T,E> adapter も存在しない**。エラー kind 別の運用（Auth → ephemeral reject、DiscordApi → 次 tick で retry、Db → 停止、など）をログだけで判定している。

業務エラーの state 表現は維持しつつ、infra / invariant エラーを分類し、境界層で扱うポリシーが必要。

## Decision
エラーコアを導入する。

- **`src/errors.ts` に AppError 判別 union を定義する**:
  ```ts
  type AppError =
    | { kind: "Auth"; message: string; cause?: unknown }
    | { kind: "Validation"; message: string; cause?: unknown }
    | { kind: "Conflict"; message: string; cause?: unknown }
    | { kind: "DiscordApi"; message: string; cause?: unknown }
    | { kind: "Db"; message: string; cause?: unknown }
    | { kind: "State"; message: string; cause?: unknown }
    | { kind: "Shutdown"; message: string; cause?: unknown };
  ```
- **`neverthrow` を dependencies に追加**し、境界層（dispatcher / scheduler tick / startup / shutdown）でのみ `Result<T, AppError>` を unwrap する。domain 内部は現状の discriminated return / state 表現を維持する。
- **`fromThrowable` adapter** で既存の `throw` を Result に包み、境界層に到達した時点で kind 分類する。
- **domain 内部の業務エラー（CAS race / 重複）は引き続き state（`undefined` / discriminated return）で表現**する。Result への変換は境界層のみ。domain を書き換えない。

## Consequences

### 得られるもの
- dependencies +1（`neverthrow` は small / tree-shakable / runtime 依存軽微）。
- 境界ポリシーが 1 箇所に集約される（dispatcher / scheduler / startup / shutdown）。
- ログ分類が kind 別に可能になり、運用側で「DiscordApi 増加 → Discord 側の incident」のような切り分けが即座に可能になる。
- 未 catch の Promise rejection が境界層で確実に拾われる（`interactions.ts` の fire-and-forget を Result 化）。

### 失うもの / 制約
- `neverthrow` の学習コスト。ただし API は `Result<T, E>` / `ok` / `err` / `match` が中心で小さい。
- domain と境界で扱いが異なる（state vs Result）ため、AI エージェントがどちらを使うか迷う可能性。ルールを `.github/instructions/runtime.instructions.md` に追記して軽減する。

### 運用上の含意
- 新規 infra コード（Discord API 呼び出し / DB 書き込み）は `fromThrowable` で Result 化して境界に返す。domain は従来通り state 表現。
- 境界層（dispatcher / scheduler tick）の最外周に `match` を置き、kind 別に `logger.error({ kind, ...ctx })` → ephemeral reject / 次 tick retry / 起動停止 の分岐を書く。
- `AppError.cause` に元 Error を保持して pino redact を通す（secret 混入防止）。

## Alternatives considered

### 代替案 A: effect-ts
却下。学習曲線と runtime 依存が 1500 LOC / 個人開発規模に対して過剰。Effect / Layer / Context の概念を持ち込むほどの複雑度は無い。

### 代替案 B: fp-ts
却下。同上。Either / Task / TaskEither の型レベル表現は強力だが、本 Bot の境界数と頻度に対してオーバーエンジニアリング。

### 代替案 C: try/catch 継続（現状維持）
却下。境界ポリシーが統一されず、kind 別運用ができない。fire-and-forget の unhandled rejection リスクも残る。

### 代替案 D: 独自 Result 型を自作する
却下。`neverthrow` の型精度（`Result<T, E>` の narrow / `andThen` / `mapErr` / `match`）は十分成熟している。自作メンテコストを避ける。
