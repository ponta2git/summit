---
status: accepted
date: 2026-04-21
deciders:
  - @ponta2git
consulted:
  - Copilot CLI agent
informed: []
supersedes: []
superseded-by: []
---

# ADR-0035: Discord Send Outbox

## Context

Phase I3 の内部レビューで、state transition と Discord 送信の間に存在する crash / transient failure window が残っていると指摘された。現状は以下の形で同期配送している:

```
db.transaction(update status)  →  await channel.send / edit  →  (success/失敗は log 止まり)
```

問題:

- DB commit 成功後 / Discord 呼び出し前後で crash すると DB は最終状態 (DECIDED / CANCELLED 等) を示すのに Discord には最新 message が無い状態で乖離する。
- `updateAskMessage` の 10008 recovery (ADR-0033) と startup active probe が部分的にカバーしているが、単発の transient エラー (rate limit / Discord outage) では現 tick 内では再試行されない。
- 2 手以上の副作用 (CANCELLED→ settle notice→ startPostponeVoting→ postpone message) を途中で中断すると次 tick が回復しきれないケースが残る。

reconciler (ADR-0033) は observable な invariant の是正にフォーカスしており、"送ろうとしたが失敗した individual send" を抽象化はしていない。

## Decision

**状態遷移 tx と同一トランザクションで `discord_outbox` テーブルに行を insert する。実際の Discord 送信は scheduler cron の `outbox_worker` tick が非同期に行う。**

### スキーマ (drizzle/0006_living_hedge_knight.sql)

`discord_outbox` 列:

- `id` text PK
- `kind` text ∈ `send_message` / `edit_message` (CHECK)
- `session_id` text FK(sessions, ON DELETE CASCADE)
- `payload` jsonb — `{ kind, channelId, renderer, target?, extra }`
- `dedupe_key` text — per-session 決定論キー
- `status` text ∈ `PENDING` / `IN_FLIGHT` / `DELIVERED` / `FAILED` (CHECK)
- `attempt_count` integer
- `last_error` text
- `claim_expires_at` timestamptz — worker claim TTL
- `next_attempt_at` timestamptz — backoff 後の再試行時刻
- `delivered_at` / `delivered_message_id`
- `created_at` / `updated_at`

インデックス:

- `uq_discord_outbox_dedupe_active` UNIQUE on `dedupe_key` WHERE `status IN ('PENDING','IN_FLIGHT','DELIVERED')` — partial unique index。非 FAILED で 1 件のみ許容し、同 intent の二重 enqueue を idempotent に防ぐ。Drizzle は `.where(sql\`...\`)` で partial を綺麗に表現できる (手編集不要)。
- `idx_discord_outbox_status_next` on `(status, next_attempt_at)` — worker の claim クエリを支える。

### dedupe_key スキーム

- 初回 ask 投稿: `ask-msg-{sessionId}`
- ask 再描画 (edit): `ask-edit-{sessionId}-{sessionUpdatedAtMs}` — `sessions.updated_at` (既に CAS 毎に `now()` が入る) の epoch ms を revision として採用する。同一 revision の再 enqueue は partial unique で collapse され、本当にデータが変わった遷移でのみ新規行が生成される。
- Settle 通知: `settle-notice-{sessionId}-{reason}`
- 順延投票メッセージ: `postpone-msg-{sessionId}`
- リマインド: `reminder-{sessionId}` — `sessions.reminder_sent_at` claim は据え置き (per-session idempotency を Session row 側で担保)。outbox は送信手段のみを担う。

### Worker (src/scheduler/outboxWorker.ts)

- cron: `CRON_OUTBOX_WORKER_SCHEDULE` (src/config.ts)
- batch: `OUTBOX_WORKER_BATCH_LIMIT` 件まで `claimNextBatch` で IN_FLIGHT に atomic 遷移
- claim TTL: `OUTBOX_CLAIM_DURATION_MS`
- 成功: `markDelivered` + `payload.target` が指す Sessions 列 (`ask_message_id` / `postpone_message_id`) を back-fill
- 失敗: `markFailed` + `computeOutboxBackoff(attemptCount)` で次回再試行時刻を決定
- backoff 列: `OUTBOX_BACKOFF_MS_SEQUENCE`
- 最大試行: `OUTBOX_MAX_ATTEMPTS` を超えたら dead letter (`status=FAILED`)
- `runTickSafely` でラップし例外を閉じ込める — これが ADR-0033 期の tickRunner 基盤の最初の consumer。

### Reconciler 連携 (ADR-0033 追補)

`runReconciler(scope="startup")` に `reconcileOutboxClaims` を追加。`claim_expires_at` を過ぎた IN_FLIGHT 行を PENDING へ戻し、crash で worker が握ったまま死んだケースを回復させる。reconciler 既存の "messageId 削除検知 active probe" は残す — それは外部からの削除を救い、outbox は送信経路自体の at-least-once を救う異なる invariant である。

### /status 連携 (ADR-0032 追補)

`status` コマンドの invariant 警告に `outbox_stranded` を追加。対象は `status=FAILED` もしくは `attempt_count >= OUTBOX_STRANDED_ATTEMPTS_THRESHOLD` の行で、件数 + 最古 dedupeKey を含めて運用者に通知する。

## Consequences

**Positive**

- 状態遷移の副作用完了まで同期待機しなくて済むため、transition tx が短くなる (Discord API latency から切り離される)。
- Discord side outage / rate limit は worker の backoff に閉じ込められ、state transition 自体は一貫して commit/rollback する。
- すべての send が at-least-once + idempotent dedupe_key により観測可能になる。
- reconciler 負荷が減る: "状態は進んでいるが message が出ていない" を専ら recovery で拾う必要が無くなる (enqueue 済みなら worker が最終的に届ける)。

**Negative**

- 送信レイテンシが worker tick 周期 (`CRON_OUTBOX_WORKER_SCHEDULE` / `src/config.ts` が SSoT) 分だけ追加される。キュー滞留時は `OUTBOX_WORKER_BATCH_LIMIT` と tick 周期の積で決まる。実値は ADR/README に書き写さず定数名で参照する (ADR-0022)。
- `askMessageId` / `postponeMessageId` の populate が eventually-consistent になる (worker delivery 後に back-fill)。reconciler 起動時 gate と "sent but id not yet persisted" window の扱いを既存の startup active probe が吸収する — probe は `askMessageId IS NULL` を "まだ送っていない" ではなく "worker delivery 前" として許容する既存の挙動と整合。
- `askMessageId` / `postponeMessageId` back-fill は CAS-on-NULL セマンティクスを持つ専用 port メソッド `backfillAskMessageId` / `backfillPostponeMessageId` を使う (FR-M2 で追加)。reconciler 再投稿と outbox 配送が race した場合、先に列を埋めた側が勝ち、後続は Discord 送信には成功するが DB 列は上書きしない (`outbox.backfill_skipped` warn ログ)。意図的な上書き (reconciler / messageEditor の Unknown Message recovery / send.ts の初回送信) は従来どおり無条件 UPDATE の `updateAskMessageId` / `updatePostponeMessageId` を使う。
- 現時点で worker が dispatch 可能な renderer は以下 (`src/scheduler/outboxWorker.ts` のレジストリが SSoT):
  - `raw_text` — `extra.content` / `extra.allowedMentions` をそのまま送る汎用 renderer
  - `decided_announcement` — §5.1 開催決定メッセージ。配送時に DB から session/responses/members を
    再取得し `status !== "DECIDED"` なら undefined 返却 → dead letter (意図的)
  - `cancel_week_notice` — `/cancel_week` 成功時の通知。invoker-scoped dedupe で二重通知を抑止
  - 未登録 renderer 名は `extra.content` にフォールバック (後方互換 / 段階移行向け)
- 初期 ask post / postpone message / reminder / settle 通知は引き続き直接送信。outbox 側への段階移行は
  renderer coverage と ordering 保証 (同一 session 内の settle→postpone→reminder の配送順序) を揃えた
  上で次フェーズで進める。本 PR (ADR-0036 同梱) では state-consistent で順序非依存な
  `decided_announcement` / `cancel_week_notice` のみ先行移行した。
- `edit_message` 経路の renderer は引き続き未実装 (dead letter)。ADR-0033 の active probe と
  scheduler tick の opportunistic 再描画が `messages.fetch(10008)` → 再投稿を担う。


## Alternatives considered

1. **同期送信 + 内ループ retry**: transaction 内で retry ループを回す案。Discord API は分単位で劣化することがあり、tx を長時間開けるのは DB contention と Neon pooler の観点で不可。
2. **外部キュー (inngest / SQS / Redis Streams)**: インフラコストと運用複雑度増。単一インスタンス / 4 名 / 低 TPS 前提では割に合わない。DB outbox で十分。
3. **outbox は作るが worker は作らず、reconciler で配送**: reconciler は起動時 / tick 境界の invariant 収束が主務で、毎秒単位の delivery を任せると責務が混線する。worker を別 cron に分離する。

## Links

- docs/adr/0001-single-instance-db-as-source-of-truth.md
- docs/adr/0017-adapter-boundary.md — Discord client を抽象化しない decision
- docs/adr/0018-port-wiring-and-factory-injection.md — OutboxPort を AppPorts に追加
- docs/adr/0022-information-source-of-truth.md — cron 値 / backoff 列を config.ts に集約
- docs/adr/0024-reminder-dispatch.md — reminder claim は据え置き
- docs/adr/0032-status-command.md — /status に警告を追加
- docs/adr/0033-startup-invariant-reconciler.md — reconciler に reclaim を追加
