# TA8 Findings

**By Haiku → GPT-5.4 critique pending (R7).**

## Summary
- 判定: Low (High 0 / Medium 0 / Low 1 + Info 3)
- src/time/** は健全、ISO week 正、POSTPONE_DEADLINE 24:00 parse 正。テスト 3 件欠落のみ

## src/time API (13 exports)
- systemClock, isoWeekKey, candidateDateForAsk, formatCandidateJa/Iso, parseCandidateDateIso
- ASK_TIME_CHOICES, deadlineFor, postponeDeadlineFor, saturdayCandidateFrom
- latestChoice, decidedStartAt, reminderAtFor
- 全て pure or pure-compatible

## Date violations (src/time 外)
- `new Date()`/`Date.now()`/`Date.parse()`: **0 件** (完全遵守)
- `.toISOString()`: settle.ts:125-126 / scheduler/index.ts:174,188,204 (DB 書き込み/ログ出力の serialize 用、input は time/ 由来 → 許容)
- viewModel.ts:47 `.getHours()/.getMinutes()` (pure read)

## ISO week
- src/time/index.ts:39-44 で `getISOWeekYear` + `getISOWeek` 併用 ✅
- tests/time/jst.test.ts:15-51 で 2026W53/2027W52/2032W53/年跨ぎ網羅

## POSTPONE_DEADLINE "24:00"
- env.ts:53 zod literal 固定
- config.ts:21-39 `parseHhmm`: 24:00 受理、24 超は reject、>23<24 も OK
- postponeDeadlineFor: `startOfDay(addDays(candidateDate, 1))` で翌日 00:00 JST
- tests/time/jst.test.ts:96-107 で year boundary カバー

## DB timestamp trace
- sessions.deadlineAt ← deadlineFor (settle.ts:99)
- decidedStartAt ← decidedStartAt (settle.ts:114)
- reminderAt ← reminderAtFor (settle.ts:118)
- createdAt ← ctx.clock.now() (defaultFn 経由)

## Pure-domain modules
- features/ask-session/decide.ts:27-60 evaluateDeadline (`// invariant: pure`)
- features/ask-session/viewModel.ts:36-62 computeAskFooter (`// invariant: pure`)
- slot.ts / postpone-voting/decide.ts も pure と推定 (未詳細確認)

## Findings
### F1: time/ ユニットテスト欠落 [Low]
- latestChoice 単体テストなし (decidedStartAt 経由のみ)
- reminderAtFor 単体テストなし
- formatCandidateDateIso 単体テストなし
- 推奨: 3-4 本追加

## 備考
- 他 finding (TA5/TP2) と照合して時刻まわりに High はなし、healthy 評価で R8 結論案
