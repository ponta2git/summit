# TA6 Findings

## Summary
- 判定: 概ね準拠、改善余地あり
- High 0 / Medium 2 / Low 2

## Module-level state inventory
| file:line | symbol | 問題? |
|---|---|---|
| features/ask-session/send.ts:40 | inFlightSends (Map) | Low (DB unique/CAS が最終防衛、プロセス依存) |
| features/reminder/send.ts:21 | TIME_CHOICES (Set) | No (不変定数) |
| index.ts:22 | scheduler (let) | No (shutdown 参照) |

## Cron 登録
| file:line | 件数 | 備考 |
| scheduler/index.ts:251-252 | 4 件 | timezone=Asia/Tokyo, noOverlap=true |
| index.ts:92 | 1 回 | runStartupRecovery 後に登録 |

## Findings
### F1: runDeadlineTick はセッション単位隔離なし [Medium]
- scheduler/index.ts:77-85,80-82
- 1 件の settleDueAskingSession 失敗で同 tick の残り due 未処理
- 推奨: runPostponeDeadlineTick 同様の per-session try/catch (TA1 F1 と同根)

### F2: startup recovery の非終端定義に CANCELLED を含む [Medium]
- sessions.ts:15-21,318-325; scheduler/index.ts:168-209
- recovery は CANCELLED を取得するが処理分岐なし、仕様解釈ズレ時に停滞温床
- 推奨: 非終端集合を再定義 (CANCELLED 除外) か CANCELLED 処理方針固定
- **TA5 F1 と強く関連** (CANCELLED が仕様外収束していない問題)

### F3: in-memory ロック最適化 [Low]
- ask-session/send.ts:33-40,151-175,248-265
- 複数インスタンス無効だが単一前提なので現状維持可

### F4: recovery の DECIDED overdue reminder 分岐 test 未整備 [Low]
- tests/scheduler/deadline.test.ts:121-195
- scheduler/index.ts:194-208 の直接 test なし (TP3 F3 と重複)

## 冪等性・startup recovery 評価
- tick 毎 DB 再計算: 実施 (79,103,135,166)
- CAS/unique で冪等担保 (transitionStatus, createAskSession, claimReminderDispatch)
- catch 境界: ask/postpone-deadline/reminder tick は良好、runDeadlineTick と runStartupRecovery に改善余地
- timezone / noOverlap 明示済
- scheduler テスト 15 件 pass
