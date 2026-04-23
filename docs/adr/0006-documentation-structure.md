---
adr: 0006
title: ドキュメント構造（業務要求 / 運用 / レビュー規約の分離）
status: accepted
date: 2026-04-19
supersedes: []
superseded-by: null
tags: [docs]
---

# ADR-0006: ドキュメント構造（業務要求 / 運用 / レビュー規約の分離）

## TL;DR
`requirements/base.md` は業務要求の What/Why 専用、README は人間向け入口、`.github/instructions/*.md` は applyTo 単位の自己完結レビュー規約、`AGENTS.md` は AI 作業手順、`docs/adr/` は判断の根拠、と責務を分離する。

## Context
人間と複数 AI エージェント（Copilot / Claude Code / Codex）が共存して保守する前提でのドキュメント責務分離の決定。

Forces:
- 旧 `requirements/base.md` は約 680 行に膨張し、業務要求・実装方針・レビュー観点・運用手順が同居して正本が判別できなくなっていた。
- 業務要求と実装都合を同じ文書に書くと、仕様変更と実装変更の差分が区別できず重複転記で齟齬が起きる。
- Copilot Code Review は instructions を先頭側から優先的に読むため、参照チェーン前提の設計では規約が読み落とされる。
- 人間向け README（セットアップ入口）と AI 向け作業手順・レビュー規約は期待される情報密度が異なる。
- 判断根拠を PR 本文にだけ残すと、文書構造変更の理由が時間経過で再検索できなくなる。

## Decision

### Responsibility split (SSoT)
- `requirements/base.md` — 業務要求仕様の **What / Why 専用**。実装技術名・採用ライブラリ・コード例・ローカル開発手順・デプロイ手順・運用ノートを持ち込まない。
- `README.md` — 人間向け入口。技術スタック / 環境変数 / ローカル開発 / CI/CD / デプロイ運用 / 死活監視 / 脆弱性対応 / 将来拡張を集約する。
- `.github/instructions/*.md` — applyTo ベースで自動適用されるレビュー規約。**自己完結**にし、他文書を読まずに先頭側でレビュー判断できる粒度を保つ。単位は `runtime` / `interaction-review` / `db-review` / `time-review` / `secrets-review` の 5 つ。
- `AGENTS.md` — AI エージェント向けナビゲーション。SSoT 表・作業手順・禁止領域・既知の落とし穴。
- `.github/copilot-instructions.md` — 常時注入される要約ルール。判断に必要な要約のみで、詳細は各正本に委ねる。
- `docs/adr/` — 判断の根拠（Why / 代替案 / 採択時点の前提）。

### Invariant
- **ルール本文は AGENTS / instructions、説明責任（Why）は ADR**。同じ事実を複数文書へ転記しない（ADR-0022 の SSoT taxonomy に従う）。
## Consequences

### Follow-up obligations
- 新規ルールは「本文は AGENTS / instructions、Why は ADR」の SSoT 分離（ADR-0022）に従って配置する。同じ事実を複数文書に転記しない。
- `.github/instructions/*.md` は applyTo 単位で**自己完結**を維持する（Code Review が参照チェーンを辿れない前提）。

### Operational invariants & footguns
- **Footgun**: 文書再編時に `requirements/base.md` へ実装技術名・ライブラリ・コマンド・運用ノートを書き戻さない（What / Why 専用を維持）。
- **Footgun**: README を AI 向けレビュー規約の正本にしない（人間向けセットアップ入口と衝突して可読性が落ちる）。
- **Footgun**: 各文書の責務境界はレビューで継続監視しないと時間とともに再び混在へ戻る。新規文書追加時は SSoT 表（`AGENTS.md`）を先に確認する。

## Alternatives considered

- **単一の `base.md` にすべて集約** — 文書が肥大化し業務要求と実装・運用の境界が曖昧になる。
- **全 AI エージェント向け instruction を 1 ファイルに集約** — applyTo の粒度が失われ領域ごとのレビュー規約を自動適用できない。
- **判断の根拠を PR 本文だけに残す** — 永続性と検索性が弱く後から構造変更の理由を再利用できない。
- **README を AI 向け規約の正本にする** — 人間向け入口と衝突しセットアップ案内とレビュー規約が混在して可読性が落ちる。
