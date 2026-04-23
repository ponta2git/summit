---
adr: 0020
title: Discord モジュール再編（postpone/ 対称化と settle/ 分割）
status: accepted
date: 2026-04-24
supersedes: []
superseded-by: null
tags: [runtime, discord, docs]
---

# ADR-0020: Discord モジュール再編（postpone/ 対称化と settle/ 分割）

## TL;DR
`postponeMessage.ts` を `postpone/render.ts` に移し ask/ と対称化。膨張した `settle.ts`（419 行）を `settle/{ask,postpone,messages,index}.ts` に分割し、button handler の重複 helper は `src/errors/result.ts` と `discord/ask/choiceMap.ts` に切り出す。死んだ `resolveSendPostponedAskMessage` 間接参照を削除し、`transitionStatus` の patch を `Partial<typeof sessions.$inferInsert>` で typed 化する。

## Context
コードレビューで `src/discord/` 配下に以下の痛点が観測された（ファイル名・LOC は判断 driver として保持）:

1. **粒度の非対称**: `ask/` は `render.ts`（pure）/ `send.ts`（副作用）に分かれる一方、postpone 側は `postponeMessage.ts` 単一ファイル、かつ送信・編集ロジックは `settle.ts` 内に埋没。
2. **責務集中**: `settle.ts` が 419 行に膨張し、ASKING / POSTPONE_VOTING 両系統のオーケストレーション・DB I/O・Discord 編集・view model 構築を同居。
3. **死んだ間接参照**: `resolveSendPostponedAskMessage` は Phase E 完了後も残る `as unknown as { sendPostponedAskMessage?: ... }` ハック。直接 import で代替可能。
4. **弱い型付け**: `transitionStatus` の `patch: Record<string, unknown>` が Drizzle 生成型から乖離し、カラム追加時に型検出できない。

## Decision
後方互換シムは設けない（NodeNext で明示 `/index.js` 必須）。

### 構造変更
1. **postpone を ask と対称化**: `src/discord/postponeMessage.ts` → `src/discord/postpone/render.ts`（git mv、テストも追随）。
2. **`settle.ts` を `settle/` に分割**（@see `src/discord/settle/`）:
   - `ask.ts`: `settleAskingSession` / `tryDecideIfAllTimeSlots` / `applyDeadlineDecision` / `evaluateAndApplyDeadlineDecision` + strategy map
   - `postpone.ts`: `settlePostponeVotingSession` は thin orchestrator、`evaluateVoteOutcome` / `applyDecidedOutcome` / `applyCancelledOutcome` に分解
   - `messages.ts`: `getTextChannel` / `updateAskMessage` / `updatePostponeMessage` / `renderSettleNotice` / `CancelReason`
   - `index.ts`: barrel（外部は `./settle/index.js` を直接 import）
3. **Button handler 重複解消**: `toResultAsync` / `fromDatabasePromise` → `src/errors/result.ts`、`ASK_CUSTOM_ID_TO_DB_CHOICE` / `AskDbChoice` → `src/discord/ask/choiceMap.ts`。`.asyncMap(async v => v)` no-op は `toResultAsync(...)` へ置換。
4. **死んだ間接参照の除去**: `resolveSendPostponedAskMessage` / `SendPostponedAskMessage` を削除し `sendPostponedAskMessage` を `./ask/send.js` から直接 import。`todo(ai): Phase E` 注釈も除去。
5. **`transitionStatus` patch の typed 化**: `Record<string, unknown>` → `Partial<typeof sessions.$inferInsert>`。`sql\`now()\`` は Drizzle 型制約により `as unknown as Date` で narrow（コメント必須）。

### Invariants
- `settle/` 配下は 1 ファイル < 200 行、`settlePostponeVotingSession` は thin orchestrator を維持。
- barrel `settle/index.ts` は `export *`。新規 symbol 追加時は衝突回避のため named re-export を検討。

## Consequences

### Operational invariants & footguns
- **対称性**: ask / postpone の file layout が揃い、将来 postpone に send 側ロジックが独立すれば `postpone/send.ts` を追加する明確な場所ができた。
- **単一ファイル責務**: `settle/` 配下の各ファイルは 200 行未満。`settlePostponeVotingSession` は 24 行の thin orchestrator に縮小。
- **型強化**: `transitionStatus` のカラム追加時に typecheck がコンパイル時に検出する。`Record<string, unknown>` による silent drift を排除。
- **DRY**: Button handler 2 ファイルから 25 行の重複定義（helper + choice map）を除去。
- **死んだ抽象の削除**: phased rollout の痕跡を清算し、新規読者が誤解する余地を減らした。
- **import path の層数増加**: `settle/ask.ts` は `../../appContext.js` のように 2 階層 `../` が必要。外部からの import は `./settle/index.js` と明示する必要がある（NodeNext 解決はフォルダ名単独の auto-resolve を行わない）。
- **barrel を経由する名前衝突リスク**: `settle/index.ts` が `export *` で再 export するため、将来 settle/ 内の新規 symbol が外部と衝突した場合、意図しない export になる可能性がある。新規 symbol 追加時は named re-export を検討する（現時点は export される symbol が少数で衝突リスク低）。

## Alternatives considered
- **`src/discord/settle.ts` を barrel shim として残す** — 旧 import 互換の価値がなく、grep ノイズと不要な抽象を避けるため削除。
- **`postpone/send.ts` を新設して `updatePostponeMessage` を移動** — 現状は settle 専用 helper で独立送信責務を持たず、過剰分割を避けて settle/messages.ts に置く。
- **Branded phantom types（`GuildId` / `ChannelId` / `MemberUserId`）導入** — プロジェクト規模（~2400 LOC）に対し配線コストが重く、guard 関数での narrow を維持。
