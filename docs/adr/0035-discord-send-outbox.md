---
adr: 0035
title: Discord send outbox — atomic enqueue + worker で at-least-once 配送
status: accepted
date: 2026-04-21
supersedes: []
superseded-by: null
tags: [runtime, db, discord]
---

# ADR-0035: Discord Send Outbox

## TL;DR
状態遷移 tx と**同一トランザクション**で `discord_outbox` に行を insert し、実際の Discord 送信は cron worker (`outbox_worker`) が非同期に行う at-least-once 配送機構。`dedupe_key` の partial unique index（`WHERE status IN ('PENDING','IN_FLIGHT','DELIVERED')`）で二重 enqueue を idempotent に防ぐ。stale IN_FLIGHT は reconciler（ADR-0033）が `claim_expires_at` 超過で PENDING へ戻す。初期 ask post / postpone / reminder / settle 通知は引き続き直接送信、outbox 移行は `decided_announcement` / `cancel_week_notice` から段階的。

## Context

Phase I3 の内部レビューで、state transition と Discord 送信の間に crash / transient failure window が残ると指摘された。現状は同期配送:

```
db.transaction(update status)  →  await channel.send / edit  →  (success/失敗は log 止まり)
```

残る問題:

- DB commit 成功後 / Discord 呼び出し前後の crash で、DB は最終状態（DECIDED / CANCELLED 等）なのに Discord に最新 message が無い乖離。
- `updateAskMessage` の 10008 recovery（ADR-0033）と startup active probe で部分カバーされるが、単発の transient エラー（rate limit / Discord outage）は現 tick 内で再試行されない。
- 2 手以上の副作用（CANCELLED → settle notice → startPostponeVoting → postpone message）の中断を次 tick が回復しきれないケース。

reconciler（ADR-0033）は observable invariant の是正が責務で、「送ろうとして失敗した individual send」は抽象化していない。

## Decision

**状態遷移 tx と同一トランザクションで `discord_outbox` 行を insert。実送信は cron worker (`outbox_worker`) が非同期に行う at-least-once 配送。**

### Schema

- テーブル定義: `@see src/db/schema.ts` / `drizzle/0006_living_hedge_knight.sql`。列は `id` / `kind` / `session_id` / `payload` / `dedupe_key` / `status` / `attempt_count` / `last_error` / `claim_expires_at` / `next_attempt_at` / `delivered_at` / `delivered_message_id` / `created_at` / `updated_at`。
- `kind` ∈ `send_message` / `edit_message`（CHECK）。
- `status` ∈ `PENDING` / `IN_FLIGHT` / `DELIVERED` / `FAILED`（CHECK）。
- `session_id` FK(sessions, ON DELETE CASCADE)。

### Indexes（重要）

- **`uq_discord_outbox_dedupe_active`**: partial UNIQUE on `dedupe_key` WHERE `status IN ('PENDING','IN_FLIGHT','DELIVERED')`。**非 FAILED で 1 件のみ**許容し、同 intent の二重 enqueue を idempotent に collapse。FAILED は unique から外し、dead letter を残しつつ同 intent の再挑戦を許容。Drizzle `.where(sql\`...\`)` で表現（手編集不要）。
- `idx_discord_outbox_status_next` on `(status, next_attempt_at)`: worker claim クエリを支える。

### `dedupe_key` スキーム

- 初回 ask 投稿: `ask-msg-{sessionId}`
- ask 再描画 (edit): `ask-edit-{sessionId}-{sessionUpdatedAtMs}` — `sessions.updated_at`（CAS 毎に `now()`）の epoch ms を revision に採用。同一 revision の再 enqueue は partial unique で collapse、真に変化した遷移でのみ新規行。
- Settle 通知: `settle-notice-{sessionId}-{reason}`
- 順延投票メッセージ: `postpone-msg-{sessionId}`
- リマインド: `reminder-{sessionId}` — per-session idempotency は `sessions.reminder_sent_at` claim 側に据え置き（ADR-0024）。outbox は送信手段のみ。

### Worker

`@see src/scheduler/outboxWorker.ts`。実値は全て `src/config.ts`（ADR-0022）。

**State machine**: `PENDING → IN_FLIGHT → DELIVERED | FAILED`（dead letter）。
1. `claimNextBatch`: `OUTBOX_WORKER_BATCH_LIMIT` 件を atomic に `IN_FLIGHT` へ遷移（claim TTL = `OUTBOX_CLAIM_DURATION_MS`）。
2. 成功: `markDelivered` + `payload.target` が指す Sessions 列（`ask_message_id` / `postpone_message_id`）を back-fill。
3. 失敗: `markFailed` + `computeOutboxBackoff(attemptCount)` で `next_attempt_at` 決定（backoff 列: `OUTBOX_BACKOFF_MS_SEQUENCE`）。
4. 試行 > `OUTBOX_MAX_ATTEMPTS` で dead letter（`status=FAILED`）。
5. `runTickSafely` で例外閉じ込め — ADR-0033 期 tickRunner 基盤の最初の consumer。
6. cron: `CRON_OUTBOX_WORKER_SCHEDULE`。

### Claim expiry / reclaim（crash recovery）

stale `IN_FLIGHT`（worker が握ったまま死んだ行）は `claim_expires_at` 超過で reconciler が `PENDING` へ戻す（ADR-0033 追補: `reconcileOutboxClaims`）。既存の "messageId 削除検知 active probe" は残す（外部削除 vs 送信経路 at-least-once は**異なる invariant**）。

### Back-fill の CAS-on-NULL

- `askMessageId` / `postponeMessageId` の back-fill 用に **CAS-on-NULL** セマンティクスの専用 port `backfillAskMessageId` / `backfillPostponeMessageId`（FR-M2）。
- reconciler 再投稿と outbox 配送が race した場合: **先に列を埋めた側が勝つ**。後続は Discord 送信には成功するが DB 列は上書きしない（`outbox.backfill_skipped` warn）。
- 意図的な上書き（reconciler / messageEditor の Unknown Message recovery / send.ts 初回送信）は従来どおり無条件 UPDATE の `updateAskMessageId` / `updatePostponeMessageId` を使う（**CAS-on-NULL と無条件 UPDATE を混同しない**）。

### /status 連携（ADR-0032 追補）

invariant 警告に `outbox_stranded` を追加。対象は `status=FAILED` または `attempt_count >= OUTBOX_STRANDED_ATTEMPTS_THRESHOLD`。件数 + 最古 `dedupeKey` を運用者に表示。

### Renderer レジストリ / 段階移行

worker dispatch 可能な renderer は `src/scheduler/outboxWorker.ts` のレジストリが SSoT:
- `raw_text` — `extra.content` / `extra.allowedMentions` を汎用送出
- `decided_announcement` — §5.1 開催決定。配送時に DB から session/responses/members を再取得し `status !== "DECIDED"` なら undefined 返却 → dead letter（意図的）
- `cancel_week_notice` — `/cancel_week` 成功通知。invoker-scoped dedupe で二重通知抑止
- 未登録名は `extra.content` にフォールバック（後方互換 / 段階移行）

**本 PR では state-consistent で順序非依存な `decided_announcement` / `cancel_week_notice` のみ先行移行**。初期 ask post / postpone / reminder / settle 通知は引き続き直接送信。renderer coverage と ordering 保証（同一 session 内の settle→postpone→reminder 順序）を揃えたうえで次フェーズ。`edit_message` 経路の renderer は未実装（dead letter）。ADR-0033 active probe + scheduler tick の opportunistic 再描画が `messages.fetch(10008)` → 再投稿を担う。

## Consequences

### Follow-up obligations
- renderer coverage の段階移行: initial ask post / postpone message / reminder / settle 通知は引き続き直接送信。outbox 側への移行は renderer 実装と同一 session 内の配送順序（settle → postpone → reminder）の ordering 保証を揃えた上で次フェーズに回す。本 ADR では state-consistent かつ順序非依存な `decided_announcement` / `cancel_week_notice` のみ先行移行（@see Decision ### Renderer レジストリ / 段階移行）。
- `edit_message` 経路の renderer は未実装で現状 dead letter。ADR-0033 の active probe と scheduler tick の opportunistic 再描画（`messages.fetch(10008)` → 再投稿）が当面のカバー経路であり、常時化する場合は renderer 追加とセットで段階移行に含める。

### Operational invariants & footguns
- **back-fill API を混同しない**: `askMessageId` / `postponeMessageId` の populate は CAS-on-NULL な `backfillAskMessageId` / `backfillPostponeMessageId` を使う。意図的な上書き（reconciler / messageEditor の Unknown Message recovery / send.ts の初回送信）は無条件 UPDATE の `updateAskMessageId` / `updatePostponeMessageId`。race 時は先に列を埋めた側が勝ち、後続は Discord 送信に成功しても DB 列は上書きせず `outbox.backfill_skipped` warn ログが残る（@see Decision ### Back-fill の CAS-on-NULL）。
- **dead letter は意図的**: `decided_announcement` 配送時に DB 再取得で `status !== "DECIDED"` となった場合、renderer が undefined を返し dead letter になる。これは race 後のキャンセル（CANCELLED / SKIPPED）で古い enqueue を消費しない安全策であり、`outbox.dead_letter` ログを即エラー扱いしない。
- `outbox_stranded` 閾値の監視: eventual latency が `CRON_OUTBOX_WORKER_SCHEDULE` × `OUTBOX_WORKER_BATCH_LIMIT` を超えて滞留する場合のアラート指標。実値は `src/config.ts` を SSoT とし、ADR / README に書き写さない（ADR-0022）。
- `askMessageId` / `postponeMessageId` の populate は eventually-consistent になる。"sent but id not yet persisted" window は既存 startup active probe が `askMessageId IS NULL` を「worker delivery 前」として許容する挙動で吸収される（reconciler 再投稿と outbox 配送が race しても dedupe_key で二重送信は防がれる）。


## Alternatives considered

- **同期送信 + 内ループ retry** — tx 内で retry ループを回すと Discord API 劣化時に tx が長時間開き、DB contention と Neon pooler の観点で不可、却下。
- **外部キュー（inngest / SQS / Redis Streams）** — 単一インスタンス / 4 名 / 低 TPS ではインフラコストと運用複雑度が割に合わず DB outbox で十分、却下。
- **outbox は作るが worker は作らず reconciler で配送** — reconciler は invariant 収束が主務で毎秒単位の delivery と責務が混線するため worker を別 cron に分離、却下。

## Links

- docs/adr/0001-single-instance-db-as-source-of-truth.md
- docs/adr/0017-rejected-architecture-alternatives.md — Discord client を抽象化しない decision
- docs/adr/0018-port-wiring-and-factory-injection.md — OutboxPort を AppPorts に追加
- docs/adr/0022-ssot-taxonomy.md — cron 値 / backoff 列を config.ts に集約
- docs/adr/0024-reminder-dispatch.md — reminder claim は据え置き
- docs/adr/0032-status-command.md — /status に警告を追加
- docs/adr/0033-startup-invariant-reconciler.md — reconciler に reclaim を追加
