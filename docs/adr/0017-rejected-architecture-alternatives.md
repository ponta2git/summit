---
adr: 0017
title: 却下したアーキテクチャ代替案（XState / effect-ts / OpenTelemetry / event sourcing 他）
status: accepted
date: 2026-04-23
supersedes: []
superseded-by: null
tags: [runtime, ops, docs]
---

# ADR-0017: 却下したアーキテクチャ代替案（XState / effect-ts / OpenTelemetry / event sourcing 他）

## TL;DR
XState / effect-ts / OpenTelemetry / HMAC 署名 custom_id / discord.js component-v2 / event sourcing は現規模（1500 LOC、4 名固定、個人開発）に対し過剰として却下する。各案ごとに「再評価トリガ」を明示し、前提変化時にすぐ参照できるようにする。

## Context
アーキテクチャ最適化検討時に挑戦的な代替案を複数評価した。いずれも現規模（1500 LOC / 4 名固定 / 個人開発 / 単一インスタンス）に対し不採用だが、却下理由と**再評価トリガ**を記録しないと将来「なぜ検討しなかったのか」を再調査するコストが発生する。複数案をまとめて個別 ADR の肥大化を避けつつ、前提変化時のエントリポイントとして機能させる。

対象: XState / effect-ts / OpenTelemetry / event sourcing / HMAC 署名 custom_id / discord.js component-v2（select menu UX）。

## Decision
以下を現時点で却下。各案に**再評価トリガ**を併記し前提変化時に即参照可能とする。

### XState（session 状態機械）
却下。状態 7 / 遷移 ~10 / 1500 LOC 規模では DB state column + CAS + `assertNever` exhaustive switch で十分。DSL 学習・可視化 tooling・actor model のコストに見合わない。
- **再評価トリガ**: 状態数 15 超、ネストした並行状態、history / guard / 複雑な副作用オーケストレーションの増加。

### effect-ts
却下。runtime 依存（Effect / Layer / Context）と学習曲線が過剰。エラー処理は ADR-0015（`AppError` + `neverthrow`）で達成可能。
- **再評価トリガ**: DI / resource management / fiber 並行制御が必要な規模拡大、複数 developer による型レベル契約の必要性。

### OpenTelemetry
却下。単一インスタンス個人 bot に対し collector / exporter / backend 運用コストが価値超過。`pino` 構造化ログ + healthchecks.io ping で十分。
- **再評価トリガ**: 複数 service 分割、分散 trace が必要なレイテンシ問題、SLO ベース運用への移行。

### HMAC 署名 custom_id
却下。固定 private guild / 4 名信頼モデル下で不要（`interaction.user.id` が Discord 側署名済みで actor 詐称不可）。詳細・再評価トリガは ADR-0016。

### discord.js component-v2 / select menu UX
却下。現行（ボタン × 5 スロット）で要件十分。library 追従 + 既存 custom_id codec（ADR-0016）への影響評価コストに見合う UX 改善なし。
- **再評価トリガ**: スロット数 5 超でボタン配置破綻、ユーザーから明示的 UX 改善要望、discord.js v14 EOL + component-v2 標準化。

### Event sourcing（sessions を event log 化）
却下。監査要件・時系列再構成要件なし。Drizzle + CAS + state column で現在状態直接保持が十分。event log 化は書込み / 再構築コストとデバッグ可視性悪化を招く。
- **再評価トリガ**: 監査要件追加、過去時点の状態復元要件、業務ルール変更時に過去イベントを新ルールで再計算するニーズ。

### 運用ルール
PR で上記採用提案が出た場合、本 ADR の再評価トリガ該当可否を最初に確認。該当しない場合は本 ADR へのリンクで却下。該当時は本 ADR を supersede する新 ADR で採用判断・移行計画を記録。

## Consequences

### Follow-up obligations
- PR で上記代替案の採用提案が出た場合、本 ADR の再評価トリガ該当可否を最初に確認する。該当しない場合は本 ADR へのリンクで却下。該当時は本 ADR を supersede する新 ADR で採用判断・移行計画を記録する。

### Operational invariants & footguns
- 各代替案が提供する高度な機能（状態機械の可視化 / 型レベル DI / 分散 trace / event replay）は使えない。必要性が顕在化するまで制約として受容する。

## Alternatives considered

- **XState（session 状態機械）** — 状態 7 / 遷移 ~10 / 1500 LOC 規模では DB state column + CAS + `assertNever` で足り、DSL 学習・可視化 tooling・actor model のコストに見合わない。
- **effect-ts** — runtime 依存と学習曲線が過剰。エラー処理は ADR-0015 の `AppError` + `neverthrow` で達成可能。
- **OpenTelemetry** — 単一インスタンス個人 bot に対し collector / exporter / backend 運用コストが価値を超過。`pino` + healthchecks.io で十分。
- **HMAC 署名 custom_id** — 固定 private guild / 4 名信頼モデルでは不要。`interaction.user.id` が Discord 側で署名済みで actor 詐称は構造上不可（ADR-0016）。
- **discord.js component-v2 / select menu UX** — 現行ボタン × 5 スロットで要件十分。library 追従と既存 codec 影響評価コストに見合う改善が無い。
- **event sourcing（sessions を event log 化）** — 監査要件や時系列再構成要件が無く、state column 直接保持で足り、書込み・再構築コストとデバッグ可視性の悪化を招く。
- **個別 ADR で却下案を分散** — 却下のみの ADR が並び index が肥大化。集約のほうが俯瞰性が高く、採用判断が変わった案のみ supersede 新 ADR を切る運用で足りる。
