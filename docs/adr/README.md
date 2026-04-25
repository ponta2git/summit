# Architecture Decision Records

このディレクトリは summit の **判断根拠（Why）** を保管する append-only journal。1 決定 = 1 ファイル。削除禁止・改変禁止（supersede で更新、ADR-0022）。

- **AI の使い方**: 「なぜこの設計か」を知りたいとき本 README の [How to find the right ADR](#how-to-find-the-right-adr) から入る。
- **書き方**: テンプレートは [ADR format (MADR)](#adr-format-madr)。手順は `AGENTS.md` の「ADR プロトコル」。
- **What / 実装作法**は `.github/instructions/*.md` / `AGENTS.md` 側。本 README には書かない。

## How to find the right ADR

### By question（判断根拠を探す）

| 疑問 | 該当 ADR |
|---|---|
| この値（cron 式 / HH:MM / 閾値 / 状態名）の SSoT はどこ？ | [0022](./0022-ssot-taxonomy.md) |
| 状態遷移の原則は？（CAS / 正本 / 冪等） | [0001](./0001-single-instance-db-as-source-of-truth.md) / 実例 [0019](./0019-postpone-voting-and-saturday-reask-flow.md), [0024](./0024-reminder-dispatch.md), [0031](./0031-held-event-persistence.md) |
| Interaction / command 設計 | [0004](./0004-discord-interaction-architecture.md), [0016](./0016-customid-codec-hmac-rejected.md), [0023](./0023-cancel-week-command-flow.md), [0032](./0032-status-command.md), [0048](./0048-user-facing-copy-and-notification-policy.md) |
| test で DB / 時計を差し替える方法 | [0018](./0018-port-wiring-and-factory-injection.md) |
| エラーを throw する / しない、neverthrow の範囲 | [0015](./0015-error-core-apperror-neverthrow.md), [0045](./0045-neverthrow-boundary-scope.md) |
| 新しい feature をどこに置く / 境界は | [0025](./0025-features-directory-migration.md), [0026](./0026-boundary-rationalization.md), [0027](./0027-ui-colocation-and-shared-boundary.md), [0028](./0028-viewmodels-as-feature-assets.md), [0037](./0037-feature-locality-over-cross-cutting-extraction.md), [0040](./0040-orchestration-layer.md), [0041](./0041-feature-registry-pattern.md) |
| cross-feature な副作用フローをどこに置く | [0040](./0040-orchestration-layer.md) |
| 新しい feature の dispatcher / slash command への登録方法 | [0041](./0041-feature-registry-pattern.md) |
| JST / ISO week / 締切の扱い | [0002](./0002-jst-fixed-time-handling.md), [0019](./0019-postpone-voting-and-saturday-reask-flow.md), [0024](./0024-reminder-dispatch.md) |
| Deploy / secrets / 運用権限 | [0005](./0005-operations-policy.md), [0011](./0011-dev-mention-suppression.md), [0034](./0034-healthcheck-ping.md) |
| Discord 送信の整合性（crash / transient failure） | [0033](./0033-startup-invariant-reconciler.md), [0035](./0035-discord-send-outbox.md), [0036](./0036-reconnect-replay.md), [0042](./0042-outbox-retention-prune.md), [0043](./0043-outbox-observability-metrics.md) |
| Neon compute cost を抑える scheduler 設計は？ | [0047](./0047-db-driven-conditional-scheduler.md) |
| 代替案は既に却下されているか | [0017](./0017-rejected-architecture-alternatives.md), [0021](./0021-neverthrow-scope-reaffirmed.md), [0045](./0045-neverthrow-boundary-scope.md) |

長尾の探索は [By tag](#by-tag) か [Index](#index) へ。

### By tag

1 ADR は複数 tag を持つ。`runtime` は広範 tag のため本表から除外（frontmatter では当面維持、新規 ADR でも付与可）。

| Tag | ADR |
|---|---|
| db | 0001, 0003, 0008, 0009, 0012, 0019, 0023, 0024, 0026, 0031, 0033, 0035, 0038, 0042, 0043, 0047 |
| discord | 0004, 0007, 0009, 0011, 0016, 0017, 0019, 0020, 0023, 0024, 0025, 0026, 0027, 0028, 0030, 0032, 0033, 0035, 0036, 0037, 0040, 0041, 0045, 0047, 0048 |
| time | 0002, 0007, 0019, 0024, 0044 |
| ops | 0001, 0003, 0005, 0007, 0008, 0009, 0010, 0011, 0012, 0015, 0017, 0019, 0021, 0022, 0023, 0031, 0032, 0033, 0034, 0036, 0042, 0043, 0044, 0045, 0046, 0047 |
| docs | 0006, 0010, 0013, 0014, 0017, 0020, 0022, 0025, 0026, 0027, 0028, 0029, 0030, 0037, 0038, 0039, 0040, 0041, 0046, 0048 |
| testing | 0018 |
| dev-tools | 0029 |

## ADR format (MADR)

ファイル名: `NNNN-kebab-case-title.md`（番号は最大 +1、ゼロ詰め 4 桁）。

### Template

```markdown
---
adr: NNNN
title: <1 行タイトル>
status: proposed | accepted | deprecated | superseded
date: YYYY-MM-DD
supersedes: []       # ADR 番号の配列（あれば）
superseded-by: null  # supersede された場合は ADR 番号
tags: [runtime, db, discord, ops, docs, time, testing, dev-tools]
---

# ADR-NNNN: <タイトル>

## TL;DR
<1〜2 文で Decision を要約>

## Context
<判断を駆動した forces / constraints。一般論や Decision 先取りを書かない>

## Decision
<採用方針。命令形で簡潔に>

## Consequences
<follow-up obligations / operational invariants & footguns>

## Alternatives considered
<- **<Option>** — <1 行却下理由> 形式で列挙>

## Re-evaluation triggers  <!-- 推奨（却下を伴う決定では特に） -->
<この判断を見直すべき条件>

## Links  <!-- 任意 -->
<@see ADR-NNNN / path を列挙（タイトル文字列は rename で腐るので埋めない）>
```

### Rules

| ルール | 趣旨 |
|---|---|
| **TL;DR は必須**、1〜2 文 | AI が Decision を詳細を読まずに掴める |
| **リテラル値禁止**（cron / HH:MM / 閾値 / 状態名 / 列名） | `src/config.ts` 等の定数名のみ参照（ADR-0022）。例外: Context / Alternatives の歴史的経緯 |
| **タイトル文字列を Link に埋めない** | rename で壊れるため `@see ADR-NNNN` か path |
| **本文改変禁止**（accepted 後） | 方針変更は新 ADR + `superseded` で。Status legend 参照 |
| **tags は Topic map と整合** | 新 tag を追加するなら本 README も同時更新 |
| **Re-evaluation triggers 推奨** | 代替案却下や過渡期決定は「いつ再検討するか」を明記（例: ADR-0021） |

## Status lifecycle

### Legend

| Status | 意味 |
|---|---|
| `proposed` | 議論中・採択前 |
| `accepted` | 現行方針として採用中 |
| `superseded` | 後続 ADR に置き換えられた。`superseded-by` 必須、本文は改変しない |
| `deprecated` | 置き換え ADR なく廃止（後続 ADR が取り消したケース） |

### Supersede chain

- ADR-0008（送信専用フェーズの in-memory 実装）→ ADR-0009（DB 永続化）
- ADR-0011（開発用 mention 抑止スイッチ）→ ADR-0046（ユーザー向け設定ファイル）
- ADR-0012（member SSoT を env+DB ハイブリッドに統合する）→ ADR-0046（ユーザー向け設定ファイル）
- ADR-0013（config 階層）→ ADR-0046（ユーザー向け設定ファイル）
- ADR-0021（neverthrow 全面採用の却下）→ ADR-0045（境界・orchestration 積極導入）

## Architecture snapshot

**非正典**: 実装コード（`src/`）が唯一の正典。本節は accepted ADR 群から導出した現在のトポロジ概観で、topology を変える ADR が landing したとき更新する（手順は `AGENTS.md` の ADR プロトコル Step 2.12）。

### Layered structure

- **`src/features/*`** — 1 feature = 1 ディレクトリ。barrel なし（ADR-0025）。UI 資産・message editor は feature 同梱（ADR-0027, ADR-0028）。
- **`src/discord/shared/`** — 真 cross-cutting のみ（dispatcher / guards / customId / channels / viewModelInputs / discordErrors）。feature 固有は置かない（ADR-0026, ADR-0027, ADR-0028）。dispatcher は `src/discord/registry/` の `FeatureModule` registry で feature を解決し、自身は `customId` / `commandName` のハードコード分岐を持たない（ADR-0041）。
- **`src/discord/registry/`** — `FeatureModule` 集約レジストリ。各 feature の `module.ts` を pull し、`customIdPrefix` / `commandName` 重複を build-time に fail-fast 検証する。dispatcher と `src/commands/definitions.ts` の唯一のソース（ADR-0041）。
- **`src/time/`** — JST / ISO week / 締切計算の一元化（ADR-0002）。
- **`src/db/`** — schema / repositories / client / `ports.ts` / `rows.ts`（ADR-0003, ADR-0018, ADR-0026）。
- **`src/scheduler/`** — cron 登録・DB-driven controller・tickRunner・reconciler・outboxWorker（ADR-0033, ADR-0035, ADR-0036, ADR-0047）。
- **`src/orchestration/`** — cross-feature な副作用フローの所有層。1 use-case = 1 file。`scheduler/` と `features/*/button.ts` から呼ばれ、`features/*` の副作用関数を順序駆動する（ADR-0037, ADR-0040）。
- **infra SSoT** — `src/env.ts` / `src/userConfig.ts` / `src/config.ts` / `src/slot.ts` / `src/logger.ts` / `src/appContext.ts`（ADR-0018, ADR-0022, ADR-0030, ADR-0046）。
- **`scripts/`** — runtime 非依存の dev ツール。`src/` に置かない（ADR-0029）。

### Features

| Feature | 責務 | 根拠 |
|---|---|---|
| `ask-session` | 金曜/土曜募集の投稿・ボタン・締切処理 | ADR-0019 |
| `postpone-voting` | 順延投票メッセージ・ボタン・締切処理 | ADR-0019 |
| `reminder` | 開始 15 分前リマインド送信 | ADR-0024 |
| `decided-announcement` | 開催決定時の別投稿 | `requirements/base.md` §5.1 |
| `cancel-week` | `/cancel_week` 確認ダイアログと週単位 SKIPPED | ADR-0023 |
| `interaction-reject` | interaction 拒否時のユーザー可視文言 | ADR-0004 |
| `status-command` | `/status` 運用観測 | ADR-0032 |

各 feature は原則 `messages.ts`（文言）と `viewModel.ts`（pure builder, ADR-0028）を持つ。

### Dependency direction

```
features/*  ──► discord/shared/{dispatcher,guards,customId,channels,viewModelInputs}
           ╰──► db/ports ──► db/repositories, time/
           ╰──► slot.ts, userConfig.ts, env.ts, config.ts, logger.ts, appContext.ts
features/*/module.ts  ──► discord/registry/  (feature を registry に登録, ADR-0041)
discord/registry/  ──► features/*/{button,command}.ts  (handler 関数を pull)
discord/shared/dispatcher.ts  ──► discord/registry/  (resolveButton / resolveCommand)
commands/definitions.ts  ──► discord/registry/  (slashBuilders を導出)
features/*/button.ts, features/*/command.ts  ──► orchestration/
orchestration/  ──► features/*  (send / settle / messageEditor を順序駆動)
scheduler/      ──► orchestration/, features/* (pure), reconciler, outboxWorker
index.ts        ──► scheduler/, dispatcher, appContext, members/, healthcheck/
```

feature 相互依存は避ける。共通化が必要なら `discord/shared/` へ抽出（ADR-0025, ADR-0026, ADR-0027）。pure な型 + builder の feature 間 import のみ許容（ADR-0028）。ただし昇格は責務 cross-cutting かつ feature locality を損なわない場合に限る（ADR-0037）。副作用を伴う cross-feature フローは `src/orchestration/` に集約し、`features/*/send|settle|messageEditor.ts` の feature 間 import は `verify:forbidden` で禁止する（ADR-0040）。

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
| [0011](./0011-dev-mention-suppression.md) | 開発用 mention 抑止スイッチ（DEV_SUPPRESS_MENTIONS） | superseded | 2026-04-20 | discord, ops, runtime |
| [0012](./0012-member-ssot-env-db-hybrid.md) | member SSoT を env+DB ハイブリッドに統合する | superseded | 2026-04-23 | runtime, db, ops |
| [0013](./0013-config-layering.md) | config 階層（messages / config / constants / domain slots SSoT） | superseded | 2026-04-23 | runtime, docs |
| [0014](./0014-naming-dictionary-v2.md) | 命名辞書 v2（ADR-0010 の運用強化） | accepted | 2026-04-23 | docs, runtime |
| [0015](./0015-error-core-apperror-neverthrow.md) | エラーコア（AppError 判別 union + neverthrow を境界で） | accepted | 2026-04-23 | runtime, ops |
| [0016](./0016-customid-codec-hmac-rejected.md) | customId codec を typed にする（HMAC 署名は現時点で却下） | accepted | 2026-04-23 | discord, runtime |
| [0017](./0017-rejected-architecture-alternatives.md) | 却下したアーキテクチャ代替案（XState / effect-ts / OpenTelemetry / event sourcing 他） | accepted | 2026-04-23 | runtime, ops, docs |
| [0018](./0018-port-wiring-and-factory-injection.md) | ポート境界と factory 注入によるテスト可能な合成 | accepted | 2026-04-24 | runtime, testing, docs |
| [0019](./0019-postpone-voting-and-saturday-reask-flow.md) | 順延投票と土曜再募集フローの確定（POSTPONE_VOTING / 即時 Saturday ASKING） | accepted | 2026-04-24 | runtime, discord, db, time, ops |
| [0020](./0020-discord-module-restructuring.md) | Discord モジュール再編（postpone/ 対称化と settle/ 分割） | accepted | 2026-04-24 | runtime, discord, docs |
| [0021](./0021-neverthrow-scope-reaffirmed.md) | neverthrow 全面採用の却下とスコープ再確認 | superseded | 2026-04-24 | runtime, ops |
| [0022](./0022-ssot-taxonomy.md) | SSoT taxonomy（ADR / コード / コメント の役割分担と drift 防止） | accepted | 2026-04-24 | docs, runtime, ops |
| [0023](./0023-cancel-week-command-flow.md) | `/cancel_week` の確認ダイアログと週単位 SKIPPED 収束フロー | accepted | 2026-04-24 | discord, runtime, db, ops |
| [0024](./0024-reminder-dispatch.md) | 15 分前リマインド送信と DECIDED → COMPLETED の遷移タイミング | accepted | 2026-04-25 | runtime, discord, db, time |
| [0025](./0025-features-directory-migration.md) | feature 単位ディレクトリ（src/features/）への再編 | accepted | 2026-04-25 | runtime, discord, docs |
| [0026](./0026-boundary-rationalization.md) | 境界の再整理（domain 廃止・ports の DB 境界明示・非対称性の追認） | accepted | 2026-04-25 | runtime, db, discord, docs |
| [0027](./0027-ui-colocation-and-shared-boundary.md) | UI 資産の feature 同梱と discord/shared の境界明確化 | accepted | 2026-04-25 | runtime, discord, docs |
| [0028](./0028-viewmodels-as-feature-assets.md) | viewModel の feature 所有と discord/shared の真 cross-cutting 化 | accepted | 2026-04-25 | runtime, discord, docs |
| [0029](./0029-src-layout-tidy-up.md) | src ディレクトリの整理（dev ツール退避 / ファイル名の意図整合） | accepted | 2026-04-25 | runtime, docs, dev-tools |
| [0030](./0030-slot-pure-domain.md) | slot.ts を pure domain に縮小し slot wire を customId.ts に集約 | accepted | 2026-04-27 | runtime, discord, docs |
| [0031](./0031-held-event-persistence.md) | HeldEvent 永続化（実開催回の履歴化と DECIDED→COMPLETED の atomic 化） | accepted | 2026-04-27 | runtime, db, ops |
| [0032](./0032-status-command.md) | /status コマンドによる運用観測性の追加 | accepted | 2026-04-27 | discord, runtime, ops |
| [0033](./0033-startup-invariant-reconciler.md) | 起動時および tick 境界での invariant 収束 (startup / tick reconciler) | accepted | 2026-04-28 | runtime, db, discord, ops |
| [0034](./0034-healthcheck-ping.md) | Healthcheck ping strategy — boot ping + minute-tick ping | accepted | 2026-04-28 | runtime, ops |
| [0035](./0035-discord-send-outbox.md) | Discord send outbox — atomic enqueue + worker で at-least-once 配送 | accepted | 2026-04-21 | runtime, db, discord |
| [0036](./0036-reconnect-replay.md) | Reconnect replay on shardReady — in-flight lock + debounce + scope=reconnect | accepted | 2026-04-21 | runtime, discord, ops |
| [0037](./0037-feature-locality-over-cross-cutting-extraction.md) | feature locality 優先と cross-cutting 抽出基準の明示化 | accepted | 2026-04-24 | runtime, discord, docs |
| [0038](./0038-sessions-repository-role-split.md) | sessions repository を role-based で分割する | accepted | 2026-04-24 | db, docs |
| [0039](./0039-reconciler-invariant-based-split.md) | reconciler を invariant 単位で分割する | accepted | 2026-04-25 | runtime, docs |
| [0040](./0040-orchestration-layer.md) | orchestration layer 導入による feature 間副作用 import 解消 | accepted | 2026-04-25 | runtime, discord, docs |
| [0041](./0041-feature-registry-pattern.md) | feature registry による dispatcher の安定モジュール化 | accepted | 2026-04-25 | runtime, discord, docs |
| [0042](./0042-outbox-retention-prune.md) | Discord outbox retention — DELIVERED / FAILED 行の定期 prune | accepted | 2026-04-26 | runtime, db, ops |
| [0043](./0043-outbox-observability-metrics.md) | Outbox observability metrics — 5 分毎の depth/age 構造化ログ + warn 昇格 | accepted | 2026-04-25 | ops, db |
| [0044](./0044-time-skew-behavior-contract.md) | Time skew behavior contract — JST 固定運用下のサーバ clock 異常時挙動 | accepted | 2026-04-25 | time, runtime, ops |
| [0045](./0045-neverthrow-boundary-scope.md) | neverthrow の境界・orchestration 積極導入スコープ | accepted | 2026-04-25 | runtime, discord, ops |
| [0046](./0046-user-facing-configuration-file.md) | ユーザー向け設定ファイルと env / TypeScript 設定境界 | accepted | 2026-04-25 | runtime, ops, docs |
| [0047](./0047-db-driven-conditional-scheduler.md) | DB-driven conditional scheduler for Neon scale-to-zero | accepted | 2026-04-25 | runtime, db, discord, ops |
| [0048](./0048-user-facing-copy-and-notification-policy.md) | ユーザー向け文言と通知方針 | accepted | 2026-04-25 | discord, docs |
