# TS4 Findings

## Summary
- 判定: 概ね適合 (重大な注入/制約欠落なし)
- High 0 / Medium 2 / Low 1

## Schema constraints (抜粋)
- members: PK + UNIQUE(user_id) + display_name NOT NULL (schema.ts:15-17)
- sessions: PK + **UNIQUE(week_key, postpone_count)** (76-79) + CHECK status (82-85) + CHECK postpone_count IN (0,1) (88-90)
- responses: PK + FK(session_id) CASCADE + **UNIQUE(session_id, member_id)** (114-117) + CHECK choice (119-121)
- held_events: **UNIQUE(session_id)** + FK CASCADE (134-137)
- held_event_participants: composite PK + FK (152-163)

## 動的 SQL インベントリ
- sql`now()` のみ (sessions.ts:131,142,177,222,257,367; heldEvents.ts:92) — 入力非依存、リスク低
- CHECK 制約内の sql`` — DDL 固定文字列
- **sql.raw: 検出なし**

## Transaction scopes
- heldEvents.ts:85-164 DECIDED→COMPLETED CAS + held_events/participants を 1 tx (Yes)
- 他に db.transaction 使用箇所なし

## CAS 実装
| 遷移 | WHERE |
| 汎用 | id=? AND status=from (sessions.ts:192) |
| reminder claim | id=? AND status=DECIDED AND reminderSentAt IS NULL (225-229) |
| claim revert | id=? AND status=DECIDED AND reminderSentAt=claimedAt (260-264) |
| non-terminal→SKIPPED | id=? AND status IN (non-terminal) (370-373) |
| DECIDED→COMPLETED(held) | id=? AND status=DECIDED (tx 内) (heldEvents.ts:94-96) |

## Findings
### F1: CANCELLED→POSTPONE_VOTING 経路が分割更新 [Medium]
- features/ask-session/settle.ts:45-50,74-77
- ASKING→CANCELLED、Discord 送信、postponeMessageId 更新、CANCELLED→POSTPONE_VOTING を分割実行
- 途中失敗で CANCELLED 停留 / message-state 乖離残り得る
- **TA5 F1 / TA6 F2 と強く関連**

### F2: Ask 作成と messageId 永続化が非原子 [Medium]
- features/ask-session/send.ts:78-85,108-118; schema.ts:76-79
- createAskSession 後の Discord 送信失敗で ASKING 行のみ残り、unique で再作成不能
- 再描画 / 回復導線の明示が必要

### F3: due 判定 SELECT の将来負荷 [Low]
- sessions.ts:277,289,308-313
- findDueAsking/findDuePostponeVoting/findDueReminder に専用 index なし

## 運用ルール適合
- postgres(url, {prepare:false}) 明示 (db/client.ts:12-18)
- DIRECT_URL は drizzle.config.ts のみ
- push 禁止: verify/forbidden-patterns.sh:54, README:101,277, ADR-0003:32-35,79-80

## TP5 入力 (重い SELECT / 4 concurrent 注意パス)
- 毎分 due 系 SELECT (findDueAsking / findDuePostponeVoting / findDueReminder)
- 同時押下 4 人時の responses upsert + listResponses 集計
- ASKING→CANCELLED→POSTPONE_VOTING 分割経路と reminder claim/revert 周辺は再試行/重複判定が集中
