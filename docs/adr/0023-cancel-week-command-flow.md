---
adr: 0023
title: /cancel_week の確認ダイアログと週単位 SKIPPED 収束フロー
status: accepted
date: 2026-04-24
supersedes: []
superseded-by: null
tags: [discord, runtime, db, ops]
---

# ADR-0023: `/cancel_week` の確認ダイアログと週単位 SKIPPED 収束フロー

## TL;DR
運営都合の週中止 `/cancel_week` は ephemeral ボタン 2 個（Confirm / Abort）で誤操作を防ぐ。Confirm で週の非終端 Session 全部を CAS で `SKIPPED` 終端化、ask/postpone メッセージを disable 再描画、`cancelReason="manual_skip"`。customId は `cancel_week:{nonce}:{confirm|abort}` で session 束縛しない独立 codec。

## Context
`requirements/base.md` §7 で定義される運営都合の週中止 `/cancel_week` は、従来 `未実装です` を返す stub（ADR-0004 / ADR-0020）。実装方針を確定させる必要がある。

駆動 force:
- **誤操作リスク**: 週単位で非終端 Session 全部を終端化する破壊的操作、確認 UI が必要。
- **週キー共有**: 金曜・土曜 Session が同一 `weekKey` を持つため（ADR-0019）、session 単位でなく週単位で一括処理したい。
- **customId 方針の分岐**: 既存の `ask:{sessionId}:...` / `postpone:{sessionId}:...` は中央スロットが sessionId だが、本機能は session に紐づかない。

## Decision

### Flow
1. `/cancel_week` → **ephemeral 確認 UI**（Confirm / Abort ボタン 2 個）。slash option `confirm: boolean` は却下（誤操作リスク）。
2. Confirm → 週 (`weekKey`) の**非終端 Session 全件**を対象に CAS で `SKIPPED` 終端化。ask/postpone メッセージを disable + 「今週は見送り」フッターで再描画。チャンネル通知は **1 回のみ**（セッション数非依存）。
3. Abort / 既に終端 / 再押下 → no-op。

### customId
- **独立 codec**: `cancel_week:{nonce}:{confirm|abort}`。nonce は UUID（session と無関係）。
- 既存 `ask:` / `postpone:` の discriminated union には**混ぜない**（中央が sessionId でないため）。
- cheap-first guard（guild/channel/member）＋ ephemeral 可視性により nonce の session 束縛は不要。

### Invariants / Concurrency
- **条件付き UPDATE で CAS**: `findNonTerminalSessionsByWeekKey(weekKey)` + `NON_TERMINAL_STATUSES` を WHERE に含め、同時押下・多重実行で冪等。既終端は no-op。
- **`cancelReason = "manual_skip"`**（DB free-text）。UI 用 `CancelReason` enum（`src/messages/settle.ts`）とは別概念、UI には乗せない。
- **終端 status は `SKIPPED`**。
- **mention**: `dev.suppressMentions=true` は plain 文字列化（ADR-0046）。

### Handler 分離（ADR-0020）
- slash entry: `src/discord/commands/cancelWeek.ts`
- button: `src/discord/buttons/cancelWeekButton.ts`
- 業務ロジック: `src/discord/settle/skipWeek.ts`
- DB アクセスは Port 経由（ADR-0018）。実値は `src/config.ts` / `src/db/schema.ts` が SSoT（ADR-0022）。

## Consequences

### Operational invariants & footguns
- 週一括で非終端 Session を安全に `SKIPPED` 収束できる。
- CAS により同時実行・多重押下でも冪等（再確認は `count=0` で通知なし）。
- customId が 2 系統（session 束縛 / nonce）になるため codec エクスポートが増えるが、意味論が混ざらない利点のほうが大きい。
- `cancelReason` 列に新値 `"manual_skip"` が入る。schema は free-text なので migration 不要。
- 実値（状態名・閾値・cron）は ADR に書かず `src/config.ts` / `src/db/schema.ts` を参照（ADR-0022）。

## Alternatives considered

- **slash option `confirm: boolean`** — 1 ステップだが誤操作時のリカバリがない。却下。
- **custom_id 中央に sessionId を埋める** — 週に複数 Session が居るため週キー寄せが自然、nonce で無関連押下を防ぐ方が単純。却下。
- **既存 codec の discriminated union に合流** — 中央スロットの意味が sessionId から逸脱し読解コストが上がる。却下。
- **cron 的 auto-expire で skip** — 意思決定主体が運用者なのでスラッシュ発火が妥当。却下。
- **cancelReason に settle/messages.ts の enum 値を再利用** — UI 文言と DB 履歴理由を同一型に束ねると drift を招くため分離を維持。
