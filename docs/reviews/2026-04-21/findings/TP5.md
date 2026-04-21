# TP5 Findings

## Summary
- 判定: 改善余地大 (High 3 / Medium 3 / Low 1)
- 主因: sessions 期限系 full-scan + ASK/POSTPONE 確定時の重複 read + TS4 の atomic 問題を perf 側から追認

## Query map (抜粋)
- members/reconcile.ts:24-30 SELECT all (startup); 49-52 UPDATE; 68-71 INSERT ON CONFLICT
- repositories/members.ts:10-15 SELECT by user_id (per button); 21-25 SELECT all (per render)
- repositories/responses.ts:34-38 SELECT by session (per render/settle/reminder); 65-81 UPSERT (per button)
- repositories/sessions.ts:73-89 INSERT unique; 97-108 dedupe SELECT; 115-121 PK SELECT (buttons); 129-143 messageId UPDATE; 189-195 CAS status; 218-233 reminder claim CAS; 253-267 revert; 274-315 due-session SELECTs (status+deadlineAt / status+reminderAt); 318-341 non-terminal; 362-375 skip
- repositories/heldEvents.ts:85-163 tx (session UPDATE + held_events INSERT/SELECT fallback + participants)

## Hot path
- Ask button: 6 queries baseline (button.ts:68-156); decision 発火時 +7〜+12 (settle.ts:109-162, messageEditor.ts:17-21, decided-announcement/send.ts:56-59)
- Postpone button: 6 baseline (button.ts:73-145); settle +4 cancelled or +7 all_ok (postpone-voting/settle.ts:48-73,83-115)
- Cron/startup: scheduler/index.ts:79-82,103-107,135-139,166-209 で N+1 per session (現規模は許容、startup は due session 毎に PK 再 read)

## Findings
### F1: sessions due-scan が未 index [High]
- findDueAskingSessions/findDuePostponeVotingSessions/findDueReminderSessions (sessions.ts:274-315) が status+deadlineAt / status+reminderAt+reminderSentAt で scan
- schema.ts:71-92 は PK + (weekKey,postponeCount) unique のみ
- 推奨: partial/composite index `(status, deadline_at)` と `(status, reminder_sent_at, reminder_at)`

### F2: CANCELLED→POSTPONE_VOTING split (TS4 F1 追認) [High]
- ask-session/settle.ts:45-77: ASKING→CANCELLED → updatePostponeMessageId → CANCELLED→POSTPONE_VOTING 3 段
- scheduler/index.ts:166-209 の startup recovery は CANCELLED を処理しない
- crash window で stranded CANCELLED 発生、週が止まる
- 推奨: single tx atomic workflow + recovery marker

### F3: askMessageId 後書き (TS4 F2 追認) [High]
- ask-session/send.ts:77-117,206-212: session 作成 → 後で askMessageId を UPDATE
- crash で NULL のまま放置、startup recovery に修復経路なし

### F4: startup recovery が CANCELLED を無駄読み [Medium]
- sessions.ts:15-21,318-325 は CANCELLED を non-terminal 扱い
- scheduler/index.ts:169-209 は CANCELLED 未処理 → 無駄 scan

### F5: decided path で再 read 多重 [Medium]
- ask-session/button.ts:131-156, messageEditor.ts:17-21, decided-announcement/send.ts:56-59 で同じ session/responses/members を何度も読む
- 推奨: fresh snapshot を pass、または render input を統合

### F6: reminder 2 段 read [Medium]
- scheduler/index.ts:135-139 で due scan 後、reminder/send.ts:137-156 が PK 再 read してから claim
- 現状軽量だが 1 read 減らせる

### F7: postgres.js に statement timeout なし [Low]
- db/client.ts:12-19 に query/statement timeout 指定なし、cursor/stream 未使用
- Neon pooler 設定は適切 (max:5, prepare:false)

## Index audit (backed vs not)
- backed: sessions.id, (weekKey,postponeCount), members.userId, held_events.session_id, responses(session_id,member_id)
- not backed: status+deadlineAt, status+reminderSentAt+reminderAt, status IN (...)

## Txn boundary
- OK: completeDecidedSessionAsHeld (heldEvents.ts:85-163)
- NG: F2, F3

## Unknown
- EXPLAIN / pg_stat_statements / Neon 実測値なし
- 行数見積は 4 人固定・週 2 active session の仮定

## 他 finding との整合
- F2/F3 が TS4 F1/F2 を perf 観点で再独立追認 → R8 で Critical 候補強化
- F1 は TS4 範囲外の純 perf 発見 (独立 High)
