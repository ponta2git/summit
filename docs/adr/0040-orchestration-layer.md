---
adr: 0040
title: orchestration layer 導入による feature 間副作用 import 解消
status: accepted
date: 2026-04-25
supersedes: []
superseded-by: null
tags: [runtime, discord, docs]
---

# ADR-0040: orchestration layer 導入による feature 間副作用 import 解消

## TL;DR

cross-feature な副作用呼び出しを `src/orchestration/` に集約し、`src/features/*` 間の副作用 import（`send.ts` / `settle.ts` / `messageEditor.ts` 相互参照）を禁止する。ADR-0037 Decision §3 の実装規範化。`verify:forbidden` に `no-cross-feature-side-effect-import` を追加して回帰を CI で検知する。

## Context

`docs/reviews/2026-04-24/04-coupling-paths.md` および ADR-0028 の pure-only 原則に照らすと、`src/features/*` 配下に **5 本の副作用 feature→feature import** が残存している:

| # | from | to | 副作用関数 |
|---|---|---|---|
| E1 | `cancel-week/settle.ts` | `ask-session/messageEditor.ts` | `updateAskMessage` |
| E2 | `cancel-week/settle.ts` | `postpone-voting/messageEditor.ts` | `updatePostponeMessage` |
| E3 | `postpone-voting/settle.ts` | `ask-session/send.ts` | `sendPostponedAskMessage` |
| E4 | `ask-session/settle.ts` | `reminder/send.ts` | `skipReminderAndComplete` |
| E5 | `ask-session/settle.ts` | `decided-announcement/send.ts` | `sendDecidedAnnouncement` |

加えて `ask-session/settle.ts` の `settleAskingSession` は `channel.send(renderPostponeBody(...))` + `ctx.ports.sessions.updatePostponeMessageId(...)` で **postpone-voting feature の初期 UI を直接構築している**。形式的には import は pure でも、構造的には feature 境界を跨ぐ副作用。

ADR-0037 Decision §3 は「副作用 feature→feature import は shared 抽出ではなく scheduler / orchestrator 相当の上位層で解消する」と方針化したが、実装規範は未確定だった。

副作用フローの入口は 3 系統:
1. cron tick（`src/scheduler/index.ts`）
2. button handler（`src/features/*/button.ts`）
3. reconciler（`src/scheduler/reconciler.strandedCancelled.ts` の promoted 経路）

3 入口それぞれが feature の `settle.ts` を呼び、`settle.ts` が他 feature の副作用を直叩きする構造が 5 本の edge を生んでいる。

## Decision

### 1. 新 dir `src/orchestration/` を導入する

cross-feature な副作用フローを 1 use-case = 1 ファイルで所有する層を `src/orchestration/` に新設する。

**依存方向**:
- `src/scheduler/` → `src/orchestration/`（cron tick / reconciler が orchestration を呼ぶ）
- `src/features/*/button.ts` / `src/features/*/command.ts` → `src/orchestration/`（入口ハンドラが orchestration を呼ぶ）
- `src/orchestration/` → `src/features/*`（feature の副作用関数を順序駆動する）
- `src/features/*` ↛ `src/orchestration/`（逆流禁止）

**構成**:
```
src/orchestration/
├── index.ts               (barrel)
├── askDeadline.ts         (applyDeadlineDecision / evaluateAndApplyDeadlineDecision)
├── postponeVoting.ts      (settlePostponeVotingSession + saturday ASK 送信)
├── cancelWeek.ts          (applyManualSkip + UI 再描画 + outbox)
└── askSettleCancel.ts     (settleAskingSession + postpone init 構造ドリフト吸収)
```

### 2. feature 側の責務縮小

- `features/ask-session/settle.ts`: `tryDecideIfAllTimeSlots`（ASKING→DECIDED CAS のみ）だけを保持。`applyDeadlineDecision` / `evaluateAndApplyDeadlineDecision` / `settleAskingSession` は orchestration へ移設。
- `features/postpone-voting/settle.ts`: `settlePostponeVotingSession` を orchestration に移設。feature 側には投票結果評価 + DB 遷移 + postpone message update を担う narrow function のみ残す。
- `features/cancel-week/settle.ts`: `applyManualSkip` を orchestration に移設。feature 側は DB skip + outbox enqueue を担う narrow function のみ残す。

### 3. verify:forbidden に回帰防止ルール追加

`scripts/verify/forbidden-patterns.sh` に `no-cross-feature-side-effect-import` を追加:

- パターン: `src/features/**` 内で `from "\\.\\./[a-z-]+/(send|settle|messageEditor)\\.js"` の import を禁止。
- 慣習 3 名（`send.ts` / `settle.ts` / `messageEditor.ts`）は副作用モジュール。feature 間 import を構文的に禁止する。
- pure モジュール（`messages.ts` / `render.ts` / `viewModel.ts` / `decide.ts` / `cancelReason.ts`）は引き続き許容（ADR-0028）。

## Consequences

### Follow-up obligations

- 移設は pure code motion に限定し、behavior は不変であること。既存 test 309+ 件が挙動保証を担う。
- `tests/` は orchestration 新設に伴う import path 更新のみ。新 test カテゴリは追加しない。
- `docs/reviews/2026-04-24/` の 04 / 14 / 10 / 05 / 02 / 06 軸に再評価を書き戻す（ADR-0028 drift の「解消予定」記述を「解消済」に更新）。

### Operational invariants & footguns

- **順序保証**: settle 通知 → postpone init → CAS の順序は orchestration 内でも維持する（ADR-0035 / ADR-0019）。settle 通知を outbox 化すると順序が崩れる既知制約は不変。
- **race 挙動**: CAS が `undefined` を返した場合の race-lost を `Ok(void)` で無害化する挙動（ADR-0001）は orchestration でも維持する。
- **reconciler invariant A**（ADR-0033）: stranded CANCELLED の promoted 経路は orchestration の settleAskingSession 相当を呼ぶ形に差し替え、invariant 定義は不変。
- **新 feature 追加時**: orchestration を使う cross-feature フローがあれば 1 flow = 1 file で追加。feature 内完結なら feature 内で閉じる。「`src/orchestration/` へ置けば安全」と脊髄反射しない。
- **file size advisory**: `src/scheduler/index.ts` は本 ADR で更に膨張しない（責務を orchestration に移すため）。

### Trade-offs

- 新 dir 導入による navigation コスト（ADR-0017 の minimalism に対する tax）。flow 数が 4 以内に収まる範囲では許容。
- orchestration は multi-feature 駆動のため LCOM は自然に低い。「1 flow = 1 file」の原則で責務を明示する。

## Alternatives considered

- **`src/scheduler/` を拡張する**: ADR-0037 が併記した選択肢。却下理由 = (1) `src/features/*/button.ts → ../../scheduler/...` の逆依存が発生、(2) scheduler は「時間駆動 + reconciler invariant」を既に 2 責務抱えており膨張、(3) `scheduler/index.ts` 328 行（>300 advisory）のさらなる増大。
- **`src/discord/shared/` へ副作用を寄せる**: 却下理由 = ADR-0027 / ADR-0028 の「shared は真 cross-cutting / pure のみ」基準と衝突。feature の副作用ハブ化で責務定義が崩壊（ADR-0037 Alternatives で既に却下）。
- **feature event bus を導入する**: 却下理由 = ADR-0017 の minimalism に反する。フロー数が限定的（4 flow）で event bus の汎用性は過剰。
- **`features/*/settle.ts` に他 feature の副作用を許容する（ADR-0028 の pure-only を緩める）**: 却下理由 = ADR-0037 で既に却下。feature の副作用 ownership が曖昧化し、変更波及予測が困難。
- **orchestration 不採用で現状維持**: 却下理由 = ADR-0028 の drift を「既知項目」としてぶら下げ続けると、新 feature 追加時も同パターンが継承され負債が増える。verify:forbidden のような gate が設置できない。

## Re-evaluation triggers

- `src/orchestration/` 配下のファイル数が 6 を超える場合 → 1 orchestration = 複数 flow のサブ構造化（`orchestration/<usecase>/*.ts`）を検討。
- `src/features/` 配下が 12 feature を超える場合 → ADR-0037 と合わせて locality 基準を見直す。
- orchestration から `features/` への依存が逆流した場合（orchestration が別 orchestration を呼ぶ or feature が orchestration を import する場合）→ 依存方向の設計前提を再検討。
- 1 orchestration flow が 3 feature 以上を跨ぐようになった場合 → flow の粒度過大。use-case 分割を検討。
- 新 feature 追加時に「orchestration に置くべきか feature 内で閉じるべきか」の判断が付かないケースが累積した場合 → 判断基準を ADR 追補で明文化。

## Links

- ADR-0017（却下した代替案 / minimalism）
- ADR-0027（UI colocation と shared boundary）
- ADR-0028（viewModels as feature assets / pure-only 原則）
- ADR-0033（startup invariant reconciler / invariant A）
- ADR-0035（Discord send outbox / 順序保証）
- ADR-0037（feature locality 優先、本 ADR の基盤）
- `docs/reviews/2026-04-24/04-coupling-paths.md`
- `docs/reviews/2026-04-24/14-uniformity.md`
- `docs/reviews/2026-04-24/final-report.md`
- `scripts/verify/forbidden-patterns.sh`
