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

## Context
アーキテクチャ最適化検討時に、挑戦的な代替案を複数評価した。いずれも採用しない判断に至ったが、却下理由と**再評価トリガ**を記録しないと、将来「なぜ検討しなかったのか」を再調査するコストが発生する。本 ADR は却下案の根拠を永続化することを目的とする。

対象: XState / effect-ts / OpenTelemetry / event sourcing / HMAC 署名 custom_id / discord.js component-v2（select menu UX）。

## Decision
以下を現時点で却下する。各案に「採用すべき前提条件（再評価トリガ）」を併記する。

### XState（session 状態機械を XState で管理）
却下。状態数 7（`ASKING` / `POSTPONE_VOTING` / `POSTPONED` / `DECIDED` / `CANCELLED` / `COMPLETED` / `SKIPPED`）・遷移 ~10 本・LOC 1500 規模では、DB 側の状態 column + CAS + `assertNever` による exhaustive switch で十分。XState 導入は DSL 学習 + 可視化 tooling 運用 + actor model の理解コストに見合わない。

**再評価トリガ**: 状態数が 15 を超える、ネストした並行状態が必要になる、history / guard / 複雑な副作用オーケストレーションが増える。

### effect-ts
却下。runtime 依存（Effect / Layer / Context）と学習曲線が 1500 LOC / 個人開発規模に対して過剰。エラー処理は ADR-0015 の `AppError` + `neverthrow` で達成可能。

**再評価トリガ**: DI / resource management / fiber 単位の並行制御が必要になる規模への拡大、複数 developer 参加による型レベル契約の必要性。

### OpenTelemetry
却下。単一インスタンスの personal bot に対し、collector / exporter / backend（Tempo / Jaeger / Honeycomb 等）運用コストが価値を上回る。現状は `pino` 構造化ログ + healthchecks.io ping で観測性は十分。

**再評価トリガ**: 複数 service への分割、分散 trace が必要なレイテンシ問題の発生、SLO ベースの運用への移行。

### HMAC 署名 custom_id
却下。固定 private guild / 4 名信頼モデル下で不要（ADR-0016 参照）。`interaction.user.id` が Discord 側で署名済みのため、actor 詐称は構造上不可。

**再評価トリガ**: 外部 guild への展開、メンバー数拡大、悪意ある member を脅威モデルに含める必要性。詳細は ADR-0016。

### discord.js component-v2 / select menu UX
却下。現行 UX（ボタン × 5 スロット）は要件上十分で、変更による UX 改善が見込めない。component-v2 導入は library version 追従 + 既存 custom_id codec（ADR-0016）への影響評価コストが発生する。

**再評価トリガ**: スロット数が 5 を超えてボタン配置が破綻する、ユーザーから明示的な UX 改善要望が出る、discord.js v14 が EOL になり component-v2 が標準化する。

### event sourcing（sessions を event log 化）
却下。法定監査要件・仕様の時系列再構成要件が無く、Drizzle + CAS + state column で現在状態を直接保持する設計で十分。event log 化は書き込み・再構築コストが増え、デバッグの見通しを損なう。

**再評価トリガ**: 監査要件の追加、過去時点の状態復元要件、業務ルール変更時の "過去イベントを新ルールで再計算する" ニーズ。

## Consequences

### 得られるもの
- 現アーキテクチャの複雑度を上げない。1500 LOC を読み切れるサイズに保つ。
- 各代替案の再評価トリガが明示され、前提変化時に即座に参照できる。
- 将来の AI エージェントが「なぜ XState を使わないのか」を再調査せずに本 ADR へ辿り着ける。

### 失うもの / 制約
- 各代替案が提供する高度な機能（状態機械の可視化 / 型レベル DI / 分散 trace / event replay）は使えない。現時点では必要性が無いため制約として受容する。

### 運用上の含意
- PR で「XState / effect-ts / OpenTelemetry を入れよう」という提案が出た場合は、本 ADR の再評価トリガに該当するかを最初に確認する。該当しない場合は本 ADR へのリンクで却下する。
- 再評価トリガに該当した場合は、本 ADR を supersede する新 ADR を起票し、採用判断と移行計画を記録する。

## Alternatives considered
本 ADR 自体が「却下案の集約 ADR」のため、採用側の代替案は「各案を個別 ADR で却下する」形である。個別化せず集約した理由:

- **個別化却下**: 6 件それぞれに ADR を切ると「却下のみ」の ADR が並び、index が肥大化する。再評価トリガは短文で記述できるため、集約のほうが読みやすい。
- **本 ADR 形式採用**: 1 ファイルで却下案を俯瞰でき、将来の "他に何を検討したか" を一覧で辿れる。再評価で採用判断が変わった個別案は、その時点で本 ADR を supersede した新 ADR を切る。
