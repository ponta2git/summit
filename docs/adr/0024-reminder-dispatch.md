---
adr: 0024
title: 15 分前リマインド送信と DECIDED → COMPLETED の遷移タイミング
status: accepted
date: 2026-04-25
supersedes: []
superseded-by: null
tags: [runtime, discord, db, time]
---

# ADR-0024: 15 分前リマインド送信と DECIDED → COMPLETED の遷移タイミング

## TL;DR
`DECIDED` 遷移時に `reminder_at = decided_start_at - 15 min` を同じ UPDATE で書き、毎分 cron tick で due な Session を claim-first CAS で先着確保してからメンション送信し、`COMPLETED` へ遷移する。開催まで 10 分未満なら送信せず `reminder_sent_at=now` を skip marker として書いて直接 `COMPLETED`。orphaned claim は reconciler（ADR-0033）が閾値超過で reclaim。at-least-once semantics（欠落より重複を選ぶ）。

## Context
`requirements/base.md` §5.2 は「開催時刻の **15 分前**に 4 名全員へリマインドを送信」（開催確定から 15 分前まで 10 分未満なら送信不要）、§9.1 は `DECIDED → COMPLETED` の遷移条件を「リマインド送信完了**または**送信不要条件充足時」と定める（Bot はゲーム終了を監視しない）。

それまでの実装ギャップ:
- 金曜 ASKING の `DECIDED` 遷移は `decidedStartAt` のみ保存し、終端へ到達する経路が無かった。
- 土曜 ASKING の `DECIDED` は strategy 内で即座に `COMPLETED` へ進めており §9.1 に反し、リマインドも出ていなかった。
- Schema に `sessions.reminder_at` / `reminder_sent_at` と `reminderAtFor()` helper は既にあったが未使用。

DB-as-SoT（ADR-0001）と単一インスタンス運用の制約下で、プロセス crash でも取りこぼさず、同時実行に対しても冪等な dispatch 機構が要る。

## Decision

### Flow（at-least-once / 欠落より重複を選ぶ）
1. **`DECIDED` 遷移と同じ UPDATE** で `reminder_at = decided_start_at - 15 min` を永続化（ASKING → DECIDED CAS に `reminderAt` を含める）。
2. **毎分 cron tick** (`CRON_REMINDER_SCHEDULE`) で `status=DECIDED AND reminder_sent_at IS NULL AND reminder_at <= now` を `findDueReminderSessions(now)` で取得（port 経由、ADR-0018）。
3. **Claim-first dispatch**:
   a. DB から Session 再取得
   b. **`claimReminderDispatch`**: `UPDATE ... SET reminder_sent_at=now WHERE status=DECIDED AND reminder_sent_at IS NULL`（CAS）
   c. mention + reminder body 送信
   d. `transitionStatus(DECIDED → COMPLETED, reminderSentAt=now)` で CAS
4. **送信失敗** → `revertReminderClaim` で `reminder_sent_at=NULL` に戻し `DECIDED` のまま残す → 次 tick で再試行。
5. **CAS 敗北**（claim が undefined） → no-op。別経路が先着済み。

### Skip rule（§5.2: 開催確定〜15 分前が 10 分未満）
- **決定タイミングでのみ判定**（`decided` strategy 内）。tick 側では skip 判定しない。
- 該当時: 送信せず `reminder_sent_at=now` を skip marker として書き、直接 `COMPLETED` へ遷移。

### Invariants
- **Claim 必須**: Discord 送信の**前に** DB で先着 1 件を確保。これにより起動時 recovery と cron tick の並行実行による二重送信を排除。
- **`reminder_sent_at` は三重役割**（送信済み / skip 済み / claim 中）。claim 中は `findDueReminderSessions` から除外されるため、process crash で orphaned になりうる → **ADR-0033 reconciler** が `REMINDER_CLAIM_STALENESS_MS` 超過で reclaim。
- **Startup 順序**: scheduler (`createAskScheduler`) は **`runStartupRecovery` 完了後**に生成する。node-cron は `schedule()` 時点で auto-start するため並行を避ける（`src/index.ts` で制御）。
- **at-least-once**: 送信 API throw 時の重複送信を許容。§5.2「送る」を優先。
- **土曜 ASKING の即時 `DECIDED → COMPLETED`（旧 `completeSaturdayAskingSession`）は削除**、金曜と同一経路で終端化。

### Implementation pointers
- cron 式・15 分オフセット・skip 閾値の実値は `src/config.ts` / `src/time/` が SSoT（ADR-0022）。
- Cron handle は 4 本（ask / deadline / postpone / reminder）、shutdown で個別 stop。
- Fake ports (`createTestAppContext`) に `findDueReminderSessions` / `claimReminderDispatch` / `revertReminderClaim` / `transitionStatus(reminderSentAt)` を追加（ADR-0018、`vi.mock` 新設禁止を維持）。

## Consequences

### Follow-up obligations
- Test 面では Fake ports (`createTestAppContext`) 側に `findDueReminderSessions` / `claimReminderDispatch` / `revertReminderClaim` / `transitionStatus(reminderSentAt)` が加わる。`vi.mock` を repositories に新規追加しない原則（ADR-0018）は維持。

### Operational invariants & footguns
- 最大 ~1 分の送信遅延（毎分 tick 粒度）を許容する。実務上問題ない粒度。
- `reminder_sent_at` は「送信済み or skip 済み or claim 中」の三重役割を持つ。claim 中の行は `findDueReminderSessions` から除外されるため、claim したまま process crash した場合は当該 reminder が永久に送られない (`status=DECIDED AND reminder_sent_at IS NOT NULL` で stuck)。claim → Discord 送信の間はミリ秒オーダーであり、単一インスタンス運用と startup 順序制御により実発生確率は極めて低い。**ADR-0033 で起動時および毎分 tick 境界の reconciler が `REMINDER_CLAIM_STALENESS_MS` を超えた claim を `revertReminderClaim` で reclaim する** ため、crash 由来の orphaned claim は最大でも閾値 + 1 tick 以内に復帰する。
- Fly restart 窓中に `reminder_at` を跨いでも、再起動後の recovery で 1 分以内に送出される。
- 土曜 ASKING の即時 `DECIDED → COMPLETED` 経路（旧 `completeSaturdayAskingSession`）は削除され、金曜と同じリマインド経路で終端化される。
- Cron handle は 4 本（ask / deadline / postpone / reminder）に増え、shutdown でも個別に stop する必要がある。

## Alternatives considered

- **per-session `setTimeout` で 15 分前に firing** — プロセス再起動で state が飛ぶ / 2 インスタンスで二重発火 / DB-as-SoT から外れる。却下。
- **`DECIDED` 時点で reminder メッセージまで投稿** — 事前投稿は mention push 通知のタイミング差で UX を損なう。却下。
- **skip 判定を tick 側でも行う（両方で判定）** — 該当は edge ケースのみで、決定時点 1 回で確定させた方がログが読みやすい。却下。

## References

- `requirements/base.md` §5.2, §9.1
- `src/discord/settle/reminder.ts`（実装の実体）
- `src/scheduler/index.ts`（`runReminderTick` / `createAskScheduler`）
- `src/db/repositories/sessions.ts`（`findDueReminderSessions`, `transitionStatus(reminderSentAt)`）
- ADR-0001 単一インスタンス / DB-as-SoT
- ADR-0002 JST 固定と時刻処理集約
- ADR-0018 port 注入
- ADR-0022 SSoT taxonomy
