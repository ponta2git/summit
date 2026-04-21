# TA5 Findings

## Summary
- 判定: 要修正
- High 1 / Medium 2 / Low 1

## State Transition Matrix (summary)
- transitionStatus: from/to 任意、CAS あり / tx なし (`src/db/repositories/sessions.ts:146-196`)
- settleAskingSession: ASKING→CANCELLED / CANCELLED→POSTPONE_VOTING, CAS / 非tx
- tryDecideIfAllTimeSlots: ASKING→DECIDED, CAS / 非tx
- settlePostponeVotingSession: POSTPONE_VOTING→POSTPONED / →CANCELLED, CAS / 非tx
- claimReminderDispatch: DECIDED + reminderSentAt NULL → reminderSentAt=now, CAS / 非tx
- **completeDecidedSessionAsHeld: DECIDED→COMPLETED + held_events + participants, CAS + tx (`src/db/repositories/heldEvents.ts:85-163`)**
- skipSession: 非終端→SKIPPED, CAS

## HeldEvent Atomic Path
- sendReminderForSession → claimReminderDispatch (非tx) → Discord send → completeAfterReminder snapshots responses (time choices のみ) → completeDecidedSessionAsHeld (1 tx: CAS + insert held_events + insert participants)
- **破れうる点**: claim 後〜completion 前に crash すると DECIDED + reminderSentAt != NULL で due query/recovery の対象外 (ADR-0024 既知)

## Findings
### F1: CANCELLED が仕様どおり一時状態になっていない [High]
- requirements/base.md:227-233,269-275, src/features/ask-session/settle.ts:45-50,68-70, postpone-voting/settle.ts:83-89, sessions.ts:15-21,318-325, scheduler/index.ts:166-209
- 土曜中止と順延 NG/未完が CANCELLED 止まり (仕様は COMPLETED 収束)。さらに startup recovery が CANCELLED を処理せず宙づり
- 推奨: CANCELLED を金曜 ask→postpone 投票開始の中間状態限定に、土曜中止・順延 NG/未完は COMPLETED へ専用 API

### F2: transitionStatus が状態遷移グラフを拘束しない [Medium]
- src/db/ports.ts:48-77, sessions.ts:146-196, schema.ts:47-93
- from/to 任意、CAS は現値 only。仕様外遷移 (POSTPONED→COMPLETED 等) が容易
- 推奨: edge-specific port (cancelAsking / startPostponeVoting / completePostponeVoting / decideAsking) 化、少なくとも許可遷移 union を型で閉じる

### F3: reminder claim と atomic completion の間に永続スタック穴 [Medium]
- sessions.ts:213-234,301-315, reminder/send.ts:155-182, scheduler/index.ts:193-208, ADR-0024:42-44
- claim は completion tx より前に reminderSentAt 立てる。crash で DECIDED + reminderSentAt!=NULL のまま、due query も recovery も `reminderSentAt IS NULL` しか拾わない
- 推奨: startup recovery に stale-claim 回復、または claim 専用列を分離して timeout/reclaim

### F4: fake held-events port が real の tx rollback/FK を再現しない [Low]
- heldEvents.ts:85-109,138-163 vs tests/testing/ports.ts:344-400, schema.ts:152-157
- fake は先に transitionStatus で COMPLETED 化してから検証 / member FK 未模倣
- 推奨: fake でも pre-validate 後に mutate、failure rollback 模倣

## 不足テスト
- 土曜中止 / 順延 NG・未完 → COMPLETED 収束 contract test (現状失敗するはず)
- DECIDED + reminderSentAt!=NULL + held_event 無 の startup recovery test
- completeDecidedSessionAsHeld rollback parity (fake vs real)
