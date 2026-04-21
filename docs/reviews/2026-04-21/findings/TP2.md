# TP2 Findings

## Summary
- 判定: OK
- High 0 / Medium 0 / Low 2 (いずれも回帰テスト不足のみ、実装に drift なし)

## 境界ケース棚卸し
- 23:59→00:00: 部分的 (jst.test.ts:96-107, cron.test.ts:38-62, deadline.test.ts:158-193) / `deadlineAt===now` 境界 test 不足
- 21:30 exact: 部分的 (jst.test.ts:78-82, deadline.test.ts:43-77) / `21:30:00` と `21:29:59.999` inclusive/exclusive 未固定
- year boundary: OK (jst.test.ts:15-52, 102-107) / scheduler/boot 統合 test なし
- POSTPONE "24:00": OK (env.test.ts:134-140, jst.test.ts:96-107) / env→config→time 統合 test なし
- missed window / restart recovery: 部分的 (deadline.test.ts:121-195) / src/index.ts の recovery→scheduler 登録順テストなし

## Findings
### F1: 境界時刻 inclusive は実装 OK だが回帰 test 不足 [Low]
- 実装は lte/<= で統一 (sessions.ts:270-316, scheduler/index.ts:73-118,169-197)、drift なし
- 現 test は「直後」はあるが「ちょうど境界」「1ms 手前」未固定
- 推奨: ASKING / POSTPONE_VOTING / reminder で deadlineAt===now と >now の両パターン追加

### F2: 起動順の回帰 test 不在 [Low]
- index.ts:19-22,85-92, scheduler/index.ts:226-253
- runStartupRecovery → createAskScheduler の順は正しいが、リファクタ耐性 test なし
- 推奨: bootstrap test で順序固定 + 「登録直後 tick 非期待」明示

## src/time/ 外の時刻生成
- 実コード 0 件 (rg ヒットはコメントのみ: decide.ts:25, viewModel.ts:2)

## 不足テスト
- runDeadlineTick: now===deadlineAt / now<deadlineAt
- runPostponeDeadlineTick: now===deadlineAt / 23:59:59.999→00:00:00.000
- findDueReminderSessions: reminderAt===now
- src/index.ts startup → scheduler 順序固定
- env→config→time で POSTPONE_DEADLINE="24:00" が翌日 00:00 JST に到達する統合確認
