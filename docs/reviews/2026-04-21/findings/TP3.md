# TP3 Findings

## Summary
- 判定: 要修正 / High 0 / Medium 1 / Low 2
- claim 後 crash/例外で `DECIDED + reminderSentAt != NULL + held_event absent` が永久放置される (ADR-0024 既知リスク確認)

## Crash Matrix
| 落ちる箇所 | DB 状態 | 次 tick | startup recovery | 復旧手段 |
|---|---|---|---|---|
| claim 前 | DECIDED, reminderSentAt=NULL | Yes | Yes | 自動 retry |
| claim 後 / send 前 | DECIDED, reminderSentAt!=NULL, held_event 無 | **No** | **No** | **manual 介入のみ** |
| send 後 / completion 前 | 同上 | No | No | 同上 |
| heldEvent tx 中 crash | claim 残 / tx commit 前 | No | No | 同上 |
| completion commit 後 | COMPLETED, held_event 有 | N/A | N/A | 不要 |
| Discord send throw | revertReminderClaim 成功で NULL | Yes | Yes | 次 tick retry |

## Findings
### F1: claim 後の crash で reminder が恒久 stuck [Medium]
- sessions.ts:213-234,301-325; reminder/send.ts:155-182; scheduler/index.ts:193-208; ADR-0024:30-43
- `claimReminderDispatch` は送信前に reminderSentAt=now 確定
- `findDueReminderSessions` と startup recovery の reminder 経路とも `reminderSentAt IS NULL` のみ対象
- `sendReminderForSession` の rollback は Discord send catch のみ、後段 crash は戻せない
- 推奨: startup recovery で `DECIDED + reminderSentAt!=NULL + held_event absent` を検知し reclaim / re-complete、または claim 専用列 + timeout reclaim (lease)

### F2: stuck を検知する観測点がない [Low]
- reminder/send.ts:101-111,175-177; scheduler/index.ts:141-148,200-208
- 成功/send failure/tick failure/recovery dispatch の log のみ、stale claim 能動検知なし
- HEALTHCHECK_PING_URL は reminder stuck 検知に未接続
- 推奨: startup/定期で stale-claim 件数 warn、health/metric 出力

### F3: stuck 穴と recovery 条件差分の test 不足 [Low]
- reminder.test.ts:126-158; cron.test.ts:89-137; deadline.test.ts:121-195; persistence.test.ts:58-173
- recovery が NULL 行のみ拾うこと、stale claim 未処理を固定する回帰 test なし
- claimReminderDispatch / findDueReminderSessions / findNonTerminalSessions の条件差 test なし

## 検知・観測の gap
- stale claim 専用 detector なし
- startup recovery は reminderSentAt===null の行のみ静かに処理、claimed-but-unfinished を log しない (scheduler/index.ts:193-208)
- HEALTHCHECK_PING_URL は reminder 健全性に未接続

## 不足テスト
- runStartupRecovery が overdue DECIDED reminder を処理する test
- DECIDED + reminderSentAt!=NULL + held_event absent が tick/recovery とも拾われないことの明示 test
- claimReminderDispatch / findDueReminderSessions / findNonTerminalSessions 差分の repository test
- manual recovery は /cancel_week のみで reminder 再発火コマンドなし (commands/definitions.ts:3-10)
