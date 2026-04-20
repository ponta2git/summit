---
id: "0024"
title: "15 分前リマインド送信と DECIDED → COMPLETED の遷移タイミング"
status: accepted
date: 2026-04-25
tags: [runtime, discord, db, time]
supersedes: []
superseded-by: []
---

# 15 分前リマインド送信と DECIDED → COMPLETED の遷移タイミング

## Context

`requirements/base.md` §5.2 は「**開催時刻の 15 分前に 4 名全員へリマインドを送信する**。ただし開催が確定した瞬間から開催 15 分前までが 10 分未満の場合はリマインドを送らない」旨を定める。
§9.1 は `DECIDED → COMPLETED` の遷移条件を「リマインド送信完了 **または** 送信不要条件を満たした時点」とする。Bot は実際のゲーム終了を監視しない。

それまでの実装は:

- 金曜 ASKING の `DECIDED` 遷移は `decidedStartAt` のみを保存し、終端へ到達する経路が無かった。
- 土曜 ASKING の `DECIDED` 遷移は同じ strategy 内で即座に `COMPLETED` に進めていた（仕様違反。§9.1 に反し、かつリマインドも出していなかった）。
- Schema には `sessions.reminder_at` / `sessions.reminder_sent_at` カラムが既にあり、`reminderAtFor()` helper も存在していた（未使用）。

DB-as-SoT（ADR-0001）と単一インスタンス運用（Fly 1 instance）の制約下で、プロセスが落ちても取りこぼさず、同時実行に対しても冪等な dispatch 機構を用意する必要がある。

## Decision

1. **`DECIDED` 遷移時に `reminder_at = decided_start_at - 15 min` を同じ UPDATE で永続化する。**
   - ASKING → DECIDED の CAS に `reminderAt` を含め、次段の tick 側の判定をシンプルにする。
2. **毎分 cron tick (`CRON_REMINDER_SCHEDULE`) で `status=DECIDED` かつ `reminder_sent_at IS NULL` かつ `reminder_at <= now` のセッションを拾う。**
   - `findDueReminderSessions(now)` として sessions repo / port に追加（ADR-0018 の port 経由注入）。
3. **送信フロー**: 対象 Session を DB から再取得 → mention + `messages.reminder.body` を送信 → `transitionStatus(DECIDED → COMPLETED, reminderSentAt=now)` で CAS。
   - **送信失敗時**: `reminder_sent_at` は記録せず `DECIDED` のまま残し、次 tick で再試行する。
   - **CAS race 敗北**: 別経路が先に遷移させた場合は no-op。
4. **skip rule (§5.2) の判定**: 決定直後 (`decided` strategy 内) に `shouldSkipReminder(now, reminderAt)` で判断し、`< 10 min` なら送信せず `reminder_sent_at = now` を書いたうえで `COMPLETED` に遷移する（skip marker を兼ねる）。tick 側では skip 判定を行わない（決定タイミングで確定させる）。
5. **起動時リカバリ**: `runStartupRecovery` で `status=DECIDED` かつ `reminder_at <= now` かつ `reminder_sent_at IS NULL` の Session を検出し、同じ `sendReminderForSession` を呼ぶ。
6. **リマインド実装値（cron 式・15 分オフセット・skip 閾値）は `src/config.ts` / `src/time/` に集約し、本 ADR には書き写さない（ADR-0022）。**

## Consequences

- 最大 ~1 分の送信遅延（毎分 tick 粒度）を許容する。実務上問題ない粒度。
- `reminder_sent_at` は「送信済み or skip 済み」の二重役割を持つ（find クエリの除外条件を兼ねる）。Skip 判定ログの `reason` で経路を区別できる。
- Fly restart 窓中に `reminder_at` を跨いでも、再起動後の recovery で 1 分以内に送出される。
- 土曜 ASKING の即時 `DECIDED → COMPLETED` 経路（旧 `completeSaturdayAskingSession`）は削除され、金曜と同じリマインド経路で終端化される。
- Cron handle は 4 本（ask / deadline / postpone / reminder）に増え、shutdown でも個別に stop する必要がある。
- Test 面では Fake ports (`createTestAppContext`) 側に `findDueReminderSessions` と `transitionStatus(reminderSentAt)` が加わる。`vi.mock` を repositories に新規追加しない原則（ADR-0018）は維持。

## Alternatives considered

- **per-session `setTimeout` で 15 分前に firing する**: プロセス再起動で state が飛ぶ / 2 インスタンス時に二重発火 / DB-as-SoT から外れる。却下。
- **`DECIDED` 時点で reminder メッセージまで投稿する**: Discord embed の事前投稿は mention push 通知が出ないタイミング差で UX を損なう。却下。
- **skip 判定を tick 側でも行う（両方で判定）**: skip 条件を満たすのは遅延 recovery / 遅延決定の edge ケースのみで、決定時点 1 回で確定させた方がログが読みやすい。却下。

## References

- `requirements/base.md` §5.2, §9.1
- `src/discord/settle/reminder.ts`（実装の実体）
- `src/scheduler/index.ts`（`runReminderTick` / `createAskScheduler`）
- `src/db/repositories/sessions.ts`（`findDueReminderSessions`, `transitionStatus(reminderSentAt)`）
- ADR-0001 単一インスタンス / DB-as-SoT
- ADR-0002 JST 固定と時刻処理集約
- ADR-0018 port 注入
- ADR-0022 SSoT taxonomy
