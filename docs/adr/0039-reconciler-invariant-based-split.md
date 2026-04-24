---
adr: 0039
title: reconciler を invariant 単位で分割する
status: accepted
date: 2026-04-25
supersedes: []
superseded-by: null
tags: [runtime, docs]
---

# ADR-0039: reconciler を invariant 単位で分割する

## TL;DR

`src/scheduler/reconciler.ts`（587 行 / 6 invariant + orchestrator + 7 internal helper）を ADR-0033 の invariant A–F に 1:1 対応する 9 ファイルへ `reconciler.<responsibilityKebab>.ts` サフィックス命名で分割し、`reconciler.ts` は named re-export のみの barrel に退化させる。ディレクトリ化は Node ESM `NodeNext` の解決仕様および sessions.* (ADR-0038) との統一性を崩すため却下する。public surface（types / `runReconciler` / 6 invariant）は barrel 維持で保護し consumer 4 箇所は無修正。

## Context

2026-04-24 の 15 軸品質評価（`docs/reviews/2026-04-24/`）で `03-module-cohesion.md` H-2 および `11-modifiability.md` H-1 として、`src/scheduler/reconciler.ts` が単一ファイルに以下を同居させていることが指摘された。

- ADR-0033 で定義された invariant A (stranded cancelled) / B (missing ask) / C (missing ask message) / D (probe deleted) / E (stale reminder claim) / F (outbox claim)
- Orchestrator `runReconciler` と scope 型 `ReconcileScope`
- 7 internal helper (`resolveSettleCancelReason`, `emitCancelledUiCleanup`, `promoteStranded`, `resendAskMessage`, `probeAndRecreateAskMessage`, `probeAndRecreatePostponeMessage`, `isFridayAskWindow`)
- 2 public types / 2 internal const

新 invariant 追加時のレビュー範囲が 587 行全体に及び、ADR-0033 invariant 名と実装ファイル構造が一致せず on-call が invariant 別コードを grep で到達しづらい。ADR-0017 の「個別ファイル 300 行を advisory 閾値」を明確に超える。

ADR-0038 で sessions.* に `repositories/sessions.<role>.ts` 形式（flat + suffix + barrel）が採用され、以降の大ファイル分割はこの規範を scheduler に拡張するか、ディレクトリ化を選ぶかの判断が必要になった。

## Decision

`src/scheduler/reconciler/` ディレクトリは作らず、`src/scheduler/` 直下に `reconciler.<responsibilityKebab>.ts` サフィックス命名で invariant 単位に分割する:

| file | 責務 |
|---|---|
| `reconciler.ts` | **barrel**。public API（types / `runReconciler` / 6 invariant）を named re-export のみ。実装コードを持たない |
| `reconciler.types.ts` | `ReconcileReport` / `ReconcileScope` |
| `reconciler.run.ts` | `runReconciler` + `EMPTY_REPORT`（orchestrator のみが使用） |
| `reconciler.strandedCancelled.ts` | invariant A + `resolveSettleCancelReason` / `emitCancelledUiCleanup` / `promoteStranded` |
| `reconciler.missingAsk.ts` | invariant B + `isFridayAskWindow` + `FRIDAY_JS_DAY` |
| `reconciler.missingAskMessage.ts` | invariant C + `resendAskMessage` |
| `reconciler.probeDeleted.ts` | invariant D + `probeAndRecreateAskMessage` / `probeAndRecreatePostponeMessage` |
| `reconciler.staleReminderClaims.ts` | invariant E |
| `reconciler.outboxClaims.ts` | invariant F |

barrel は `export *` を使わず named list で re-export し、internal helper 7 種の漏出を静的保証する。ファイル先頭 TSDoc で `Invariant A (ADR-0033): ...` 形式の letter 表記を維持し、file 名自体は letter 非依存な descriptive 名を採用する。

## Consequences

- public surface 8 名（`ReconcileReport`, `ReconcileScope`, `runReconciler`, 6 invariant）は barrel 経由で不変。`src/index.ts` / `src/scheduler/index.ts` / `tests/scheduler/reconciler.test.ts` / `tests/scheduler/outboxWorker.test.ts` の 4 consumer は無修正で pass する。
- `docs/reviews/2026-04-24/03-module-cohesion.md` H-2 / `11-modifiability.md` の残存変更集中点 / `14-uniformity.md` file-size advisory の 2 件目が解消対象になる。
- 新 invariant 追加は新規ファイル作成 + `reconciler.run.ts` への 1 行追加に局所化される。既存 invariant のロジック修正は該当ファイルに閉じる。
- 各 invariant file が ADR-0033 invariant と 1:1 で対応し、構造化 log event 名（`reconciler.cancelled_promoted` 等）との照合が grep ベースで容易になる。on-call 監査時のトレースパスが改善する。
- `tests/scheduler/reconciler.test.ts`（595 行）は本 ADR の対象外。pure code motion で behavior 保証を最大化するため、test 分割は follow-up で invariant ごとにミラーする。
- 過渡期の妥協なし。pure code motion + barrel 化のみで、振る舞い・DB スキーマ・log event 名・TSDoc 文面は完全不変。

## Alternatives considered

- **`src/scheduler/reconciler/` ディレクトリ化 + `index.ts` 置換** — 却下。Node ESM + `moduleResolution: NodeNext` は `./reconciler.js` を `./reconciler/index.js` に自動解決しない（明示 import 必須）。consumer 4 箇所の import path を書き換える必要があり、ADR-0038 の「barrel 維持で consumer 無修正」規範と整合しない。
- **`reconciler.ts` + 同名 `reconciler/` ディレクトリの併用** — 却下。ファイル名とディレクトリ名が同一になり IDE / grep / tree 表示での可読性を下げる。TypeScript の型エラー位置表示でも file path が紛らわしくなる。
- **flat without barrel（consumer が直接 invariant file を import）** — 却下。consumer 4 箇所の書き換えが発生し、ADR-0038 で確立した「barrel 責務 = 境界保護」と不整合。sessions.* と規範が割れる。
- **stage-based / scope-based 分割（startup/reconnect/tick × 層）** — 却下。scope は orchestrator の関心事で、invariant は scope 横断で再利用される（例: invariant E は全 scope）。scope で切ると invariant が複数ファイルに分散し重複コードが発生する。
- **letter-based 命名（`reconciler.a.ts` 等）** — 却下。ADR-0033 の letter が改訂された場合に file rename が波及する。descriptive 名 + TSDoc で letter 表記することで両者を独立に保つ。
- **現状維持** — 却下。ADR-0017 の advisory 閾値を明確に超え、invariant 名と実装が構造レベルで対応しないことによる修正容易性の劣化が 15 軸評価で H 優先度として残り続ける。

## Re-evaluation triggers

- invariant 数が 10 を超え、orchestrator 側のルーティングが自明でなくなったとき（scope × invariant のマトリクスを型で表現する別方式を再検討）。
- `tests/scheduler/reconciler.test.ts` も分割が必要になったとき（test 側も invariant 別ファイルにミラーし、file 命名規範を本 ADR と同期させる）。
- `src/scheduler/` 配下の他ファイル（`scheduler/index.ts` 328 行 / `outbox.ts` 299 行 等）が同じ advisory を超えたとき。命名戦略（`<module>.<responsibility>.ts` vs ディレクトリ化）を本 ADR を基準に再確認する。
- Node ESM の directory index 自動解決が TypeScript / Node で正式サポートされたとき（ディレクトリ化の却下理由の主要前提が崩れる）。

## Links

- `@see ADR-0017` — 個別ファイル 300 行の advisory 閾値
- `@see ADR-0033` — 本 ADR の実装対象である invariant A–F の定義（supersede しない、実装規範として参照）
- `@see ADR-0036` — reconnect replay / scope=reconnect の扱い
- `@see ADR-0038` — sessions repository role split の先例（flat + suffix + barrel 規範）
- `@see docs/reviews/2026-04-24/03-module-cohesion.md` — 分割根拠
- `@see docs/reviews/2026-04-24/11-modifiability.md` — 変更集中点の指摘
