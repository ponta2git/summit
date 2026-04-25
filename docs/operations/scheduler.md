# Scheduler Operations

Summit は Fly の Bot process を常時起動し、Neon DB への idle polling を抑えるため DB-driven scheduler controller を使う (ADR-0047)。

関連定数 SSoT: `src/config.ts`。本 runbook では実値を書き写さず、定数名のみ参照する。

## 動作概要

| 対象 | 駆動方式 |
|---|---|
| 自動 ask 投稿 | `CRON_ASK_SCHEDULE` の固定 cron |
| healthcheck ping | `HEALTHCHECK_PING_INTERVAL_CRON` の固定 cron |
| outbox retention | `CRON_OUTBOX_RETENTION_SCHEDULE` の固定 cron |
| deadline / postpone deadline / reminder | DB hint から one-shot timer |
| outbox worker | 配送対象がある間だけ burst worker |
| missed wake / timer 消失の回復 | `CRON_SCHEDULER_SUPERVISOR_SCHEDULE` |

## 運用上の見方

- `event=scheduler.wake_requested` — interaction / startup / reconnect / timer から再計算が要求された。
- `event=scheduler.recompute_started` / `event=scheduler.recompute_finished` — DB hint から timer / worker 状態を再構築した。
- `event=scheduler.timer_scheduled` — 次の deadline / reminder / outbox retry に向けて one-shot timer を張った。
- `event=scheduler.worker_started` / `event=scheduler.worker_stopped` — outbox burst worker が稼働/停止した。
- `tick=scheduler_supervisor` — missed wake の fallback。これが定期的に出ていれば controller は自己修復できる。

## トラブルシュート

### `/ask` や button は反応するが通知投稿が遅い

1. `event=scheduler.wake_requested` が操作直後に出ているか確認する。
2. `event=scheduler.worker_started` が出ているか確認する。
3. `event=outbox.retry_scheduled` / `event=outbox.dead_letter` を確認する。
4. wake が出ていなければ、次の `tick=scheduler_supervisor` で回復する。継続する場合は wake wiring の回帰として修正する。

### Neon compute hours が想定より高い

1. Neon Console で compute active time を確認する。
2. `tick=scheduler_supervisor` の頻度が `CRON_SCHEDULER_SUPERVISOR_SCHEDULE` と一致するか確認する。
3. 平常時に `event=scheduler.worker_started` が出続けていないか確認する。
4. pending / in-flight outbox が残っていないか [outbox.md](./outbox.md) を確認する。

### reminder が送られない

1. `event=scheduler.timer_scheduled` の `timer=reminder` が出ているか確認する。
2. `tick=scheduler_supervisor` が出ているか確認する。
3. stale claim の可能性があれば `event=reconciler.reminder_claim_reclaimed` を確認する。
4. 手動 DB `UPDATE` はしない。再起動または redeploy で startup recovery に収束させる。

## 注意

Fly Machine は止めない。Discord Gateway bot は HTTP auto-start で interaction を受けられないため、停止中は slash command / button を即時受信できない。
