# Architecture Decision Records

このディレクトリは summit プロジェクトの Architecture Decision Record (ADR) を保管する。

## 目的
- **決定の記録**: 何を・なぜ選んだか、どの代替案を見送ったかを残す。
- **AI 参照**: エージェントが判断時に根拠へ辿れるようにする。
- **変更管理**: 判断が無効化された場合は新 ADR で supersede する（既存は削除せず `status: superseded` に変える）。

## フォーマット（MADR 準拠の最小形）
各 ADR は frontmatter + 本文の Markdown。1 ファイル 1 決定。ファイル名は `NNNN-kebab-case-title.md`。

```markdown
---
adr: NNNN
title: <1 行>
status: proposed | accepted | deprecated | superseded
date: YYYY-MM-DD
supersedes: []       # ADR 番号の配列（あれば）
superseded-by: null  # supersede された場合は ADR 番号
tags: [runtime, db, discord, ops, docs, time, ...]
---

# ADR-NNNN: <タイトル>

## Context
（判断が必要になった背景・制約・前提）

## Decision
（選んだ方針。命令形で簡潔に）

## Consequences
（この決定の結果得られるもの／失うもの／運用上の含意）

## Alternatives considered
（検討した代替案と却下理由）
```

## 運用ルール
- **Status の扱い**: 新規決定は `accepted` で登録。後続で方針変更する場合は、新 ADR を作り旧 ADR を `superseded` に変え、`superseded-by` を埋める。削除はしない。
- **Date**: 初回採択日を記録（再レビューで変わらない）。
- **参照**: 他ドキュメント（`AGENTS.md` / `.github/instructions/*.md` 等）からは `docs/adr/NNNN-xxx.md` をリンクする。逆方向（ADR から他ドキュメント）は極力参照しない（ADR は自己完結）。

## Index
| ID | Title | Status | Date | Tags |
|---|---|---|---|---|
| [0001](./0001-single-instance-db-as-source-of-truth.md) | 単一インスタンス常駐運用と DB を正本とする状態管理 | accepted | 2026-04-19 | runtime, ops, db |
| [0002](./0002-jst-fixed-time-handling.md) | JST 固定と時刻処理の集約 | accepted | 2026-04-19 | time, runtime |
| [0003](./0003-postgres-drizzle-operations.md) | Postgres データストアと Drizzle マイグレーション運用 | accepted | 2026-04-19 | db, runtime, ops |
| [0004](./0004-discord-interaction-architecture.md) | Discord Interaction ハンドリングと Slash Command 同期 | accepted | 2026-04-19 | discord, runtime |
| [0005](./0005-operations-policy.md) | 運用ポリシー（Staging 不採用・禁止窓・依存更新・最小権限） | accepted | 2026-04-19 | ops |
| [0006](./0006-documentation-structure.md) | ドキュメント構造（業務要求 / 運用 / レビュー規約の分離） | accepted | 2026-04-19 | docs |
| [0007](./0007-ask-command-always-available-and-08-jst-cron.md) | `/ask` コマンドの常時実行許可と自動送信時刻 08:00 JST | accepted | 2026-04-20 | discord, ops, runtime, time |
| [0008](./0008-transitional-send-only-implementation-without-db.md) | 送信専用フェーズにおける DB 未使用実装と in-memory 重複防止（過渡期） | superseded | 2026-04-20 | runtime, db, ops |
| [0009](./0009-persist-sessions-and-responses.md) | Session / Response を DB に永続化し順延確認メッセージ投稿までを実装 | accepted | 2026-04-21 | runtime, db, discord, ops |
| [0010](./0010-code-comment-and-naming-conventions.md) | コメント / ネーミング規約（AI フレンドリーな最小十分コメント） | accepted | 2026-04-22 | docs, runtime, ops |
| [0011](./0011-dev-mention-suppression.md) | 開発用 mention 抑止スイッチ（DEV_SUPPRESS_MENTIONS） | accepted | 2026-04-20 | discord, ops, runtime |
| [0012](./0012-member-ssot-env-db-hybrid.md) | member SSoT を env+DB ハイブリッドに統合する | accepted | 2026-04-23 | runtime, db, ops |
| [0013](./0013-config-layering.md) | config 階層（messages / config / constants / domain slots SSoT） | accepted | 2026-04-23 | runtime, docs |
| [0014](./0014-naming-dictionary-v2.md) | 命名辞書 v2（ADR-0010 の運用強化） | accepted | 2026-04-23 | docs, runtime |
| [0015](./0015-error-core-apperror-neverthrow.md) | エラーコア（AppError 判別 union + neverthrow を境界で） | accepted | 2026-04-23 | runtime, ops |
| [0016](./0016-customid-codec-hmac-rejected.md) | customId codec を typed にする（HMAC 署名は現時点で却下） | accepted | 2026-04-23 | discord, runtime |
| [0017](./0017-rejected-architecture-alternatives.md) | 却下したアーキテクチャ代替案（XState / effect-ts / OpenTelemetry / event sourcing 他） | accepted | 2026-04-23 | runtime, ops, docs |
| [0018](./0018-port-wiring-and-factory-injection.md) | ポート境界と factory 注入によるテスト可能な合成 | accepted | 2026-04-24 | runtime, testing, docs |
| [0019](./0019-postpone-voting-and-saturday-reask-flow.md) | 順延投票と土曜再募集フローの確定（POSTPONE_VOTING / 即時 Saturday ASKING） | accepted | 2026-04-24 | runtime, discord, db, time, ops |
| [0020](./0020-discord-module-restructuring.md) | Discord モジュール再編（postpone/ 対称化と settle/ 分割） | accepted | 2026-04-24 | runtime, discord, docs |
| [0021](./0021-neverthrow-scope-reaffirmed.md) | neverthrow 全面採用の却下とスコープ再確認 | accepted | 2026-04-24 | runtime, ops |
