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

## Context
コードレビューで `src/discord/` 配下に粒度の非対称と責務集中が観測された:

1. **粒度の非対称**: `ask/` は `render.ts`（pure）と `send.ts`（副作用）に分かれていたが、postpone 側は `postponeMessage.ts` が単一ファイルで存在し、かつ postpone 関連の送信・メッセージ更新ロジックが `settle.ts` に埋没していた。
2. **責務集中**: `settle.ts` は 419 行に膨張し、ASKING 系（金曜/土曜の締切処理）と POSTPONE_VOTING 系（順延投票締切・土曜再募集）のオーケストレーション、DB I/O、Discord メッセージ編集、view model 構築までを同居させていた。
3. **死んだ間接参照**: `settle.ts` 内の `resolveSendPostponedAskMessage` は Phase E 完了後も残っていた `as unknown as { sendPostponedAskMessage?: ... }` ハック。phased rollout の副産物であり、現時点では直接 import で代替可能。
4. **弱い型付け**: `transitionStatus` の `patch: Record<string, unknown>` が Drizzle の生成型と乖離し、カラム追加時に型エラーで検出できない状態だった。

## Decision
以下の構造変更を行い、粒度・責務・型を整える。後方互換のため既存 import パスは壊さない。

1. **postpone モジュールを ask/ と対称化**: `src/discord/postponeMessage.ts` → `src/discord/postpone/render.ts` に移動（git mv）。テストも `tests/discord/postpone/render.test.ts` に揃える。
2. **settle.ts を `settle/` ディレクトリに分割**:
   - `settle/ask.ts`: `settleAskingSession` / `tryDecideIfAllTimeSlots` / `applyDeadlineDecision` / `evaluateAndApplyDeadlineDecision` とその strategy map。
   - `settle/postpone.ts`: `settlePostponeVotingSession` を thin orchestrator に戻し、`evaluateVoteOutcome` / `applyDecidedOutcome` / `applyCancelledOutcome` に分解。
   - `settle/messages.ts`: `getTextChannel` / `updateAskMessage` / `updatePostponeMessage` / `renderSettleNotice` と `CancelReason` 型。
   - `settle/index.ts`: barrel として外部 API を再 export。外部からは `./settle/index.js` を直接 import する（後方互換シムは設けない。NodeNext 解決で明示 `/index.js` が必要）。
3. **Button handler 重複解消**: `toResultAsync` / `fromDatabasePromise` を `src/errors/result.ts` に切り出し、`askButton.ts` と `postponeButton.ts` から import。`ASK_CUSTOM_ID_TO_DB_CHOICE` と `AskDbChoice` 型は `src/discord/ask/choiceMap.ts` に移動。`.asyncMap(async v => v)` の no-op を `toResultAsync(...)` で置換。
4. **死んだ間接参照の除去**: `resolveSendPostponedAskMessage` と `SendPostponedAskMessage` 型を削除し、`sendPostponedAskMessage` を `./ask/send.js` から直接名前付き import。`todo(ai): Phase E` 注釈も除去。
5. **`transitionStatus` patch の typed 化**: `Record<string, unknown>` → `Partial<typeof sessions.$inferInsert>` に変更。`sql\`now()\`` は Drizzle 型が `Date` 固定のため `as unknown as Date` で narrow（コメント化済）。

## Consequences
### 得られるもの
- **対称性**: ask / postpone の file layout が揃い、将来 postpone に send 側ロジックが独立すれば `postpone/send.ts` を追加する明確な場所ができた。
- **単一ファイル責務**: `settle/` 配下の各ファイルは 200 行未満。`settlePostponeVotingSession` は 24 行の thin orchestrator に縮小。
- **型強化**: `transitionStatus` のカラム追加時に typecheck がコンパイル時に検出する。`Record<string, unknown>` による silent drift を排除。
- **DRY**: Button handler 2 ファイルから 25 行の重複定義（helper + choice map）を除去。
- **死んだ抽象の削除**: phased rollout の痕跡を清算し、新規読者が誤解する余地を減らした。

### 失うもの / 運用上の含意
- **import path の層数増加**: `settle/ask.ts` は `../../appContext.js` のように 2 階層 `../` が必要。外部からの import は `./settle/index.js` と明示する必要がある（NodeNext 解決はフォルダ名単独の auto-resolve を行わない）。
- **barrel を経由する名前衝突リスク**: `settle/index.ts` が `export *` で再 export するため、将来 settle/ 内の新規 symbol が外部と衝突した場合、意図しない export になる可能性がある。新規 symbol 追加時は named re-export を検討する（現時点は export される symbol が少数で衝突リスク低）。

## Alternatives considered
- **`src/discord/settle.ts` を 1 行の barrel shim として残す**: `export * from "./settle/index.js"` で旧 import path 互換を保つ案。初期実装では採用したが、外部 import はいずれも同一リポジトリ内で一括更新可能であり、不要な抽象を残すデメリット（読者の混乱・grep ノイズ）を避けて削除した。
- **`postpone/send.ts` を新設して `updatePostponeMessage` を移動**: 現状 `updatePostponeMessage` は settle フロー専用の helper であり、`ask/send.ts` の `sendAskMessage` のような独立送信責務を持たない。過剰分割を避け settle/messages.ts に置いた。将来 postpone 送信が複雑化した時点で再評価する。
- **Branded phantom types（`GuildId` / `ChannelId` / `MemberUserId`）の導入**: 構造的型付け言語 TS で値レベルの区別を型で縛る効果はあるが、プロジェクト規模（~2400 LOC）に対して import 配線コストが重い。Guard 関数で narrow する現在の方針を維持。
