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

## Context

`requirements/base.md` §7 は運営都合で今週の開催を取り止める `/cancel_week` を定義している。dispatcher は従来 `未実装です` ephemeral のみ返す stub だった（ADR-0004 / ADR-0020）。実装方針を確定させる必要がある。

制約:
- 単一インスタンス前提（ADR-0001）。DB が正本。
- Interaction の 3 秒応答（ADR-0004）。誤操作防止の確認フロー要。
- 金曜・土曜の 2 Session が同じ `weekKey` を共有する（ADR-0019）。
- 状態名・slot 値・cron 式は `src/config.ts` / `src/db/schema.ts` が SSoT（ADR-0022）。
- customId codec は typed（ADR-0016）。

## Decision

1. **確認 UX は ephemeral ボタン 2 個**（Confirm / Abort）。slash option `confirm: boolean` 案は誤操作リスクが高いので却下。
2. **customId は独立 codec**: `cancel_week:{nonce}:{confirm|abort}`。nonce は UUID（session と無関係）。既存 `ask:` / `postpone:` の discriminated union に混ぜない（中央が sessionId ではないため）。cheap-first guard（guild/channel/member）＋ ephemeral 可視性で nonce の session 束縛は不要。
3. **対象は `ISO week` の非終端 Session**。`findNonTerminalSessionsByWeekKey(weekKey)` で取得し、`NON_TERMINAL_STATUSES` を WHERE 条件に入れた **条件付き UPDATE で CAS**（冪等）。既終端は no-op。
4. **`cancelReason = "manual_skip"`** を DB の free-text カラムへ書く。`CancelReason` UI enum（`src/messages/settle.ts`）は別概念として分離（UI には乗せない）。
5. **終端は `SKIPPED`**。ask/postpone メッセージを disable + 「今週は見送り」フッターで再描画。チャンネルに 1 回だけ通知（セッション数に依らない）。`env.DEV_SUPPRESS_MENTIONS=true` では mention を plain 文字列へ差し替え（ADR-0011）。
6. **handler 分離**: slash entry は `src/discord/commands/cancelWeek.ts`、ボタンは `src/discord/buttons/cancelWeekButton.ts`、業務ロジックは `src/discord/settle/skipWeek.ts`（ADR-0020 の分割方針に合わせる）。Port 経由で DB アクセス（ADR-0018）。

## Consequences

- 週一括で非終端 Session を安全に `SKIPPED` 収束できる。
- CAS により同時実行・多重押下でも冪等（再確認は `count=0` で通知なし）。
- customId が 2 系統（session 束縛 / nonce）になるため codec エクスポートが増えるが、意味論が混ざらない利点のほうが大きい。
- `cancelReason` 列に新値 `"manual_skip"` が入る。schema は free-text なので migration 不要。
- 実値（状態名・閾値・cron）は ADR に書かず `src/config.ts` / `src/db/schema.ts` を参照（ADR-0022）。

## Alternatives considered

- **slash option `confirm: boolean`**: 1 ステップだが誤操作時のリカバリがない。却下。
- **custom_id 中央に sessionId を埋める**: 週に複数 Session が居るため週キー寄せが自然。nonce で無関連ボタン押下を防ぐほうが単純。却下。
- **既存 codec の discriminated union に合流**: 中央スロットの意味が「sessionId」から逸脱し読解コストが上がる。却下。
- **cron 的 auto-expire で skip**: 意思決定主体が運用者なのでスラッシュ発火が妥当。却下。
- **cancelReason に既存 `settle/messages.ts` の enum 値を再利用**: UI 文言と DB 履歴理由を同じ型に束ねると drift を招く。分離を維持。
