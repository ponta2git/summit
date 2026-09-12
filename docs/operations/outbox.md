# Outbox Operations

outbox は Discord への副作用を at-least-once で配送し、Session 内の意味順序を守る仕組み。本ファイルは **観測値の読み方 / retention / stranded 対応** をまとめる。

ここで扱う OutboxPort・metrics・起動時回復は共通通知 DB の attendance family に限定する。A/Bの状態確認・再試行は[通知運用](result-notifications.md)を参照する。

設計正本: `docs/db-rule.md`。scheduler との接続は `docs/architecture.md`。
関連定数 SSoT: `src/config.ts` (定数名のみ参照、実値は SSoT 側で確認)

## 観測値

`scheduler_supervisor` tick 内で `event=outbox.metrics` として出力される構造化ログ。頻度は `CRON_SCHEDULER_SUPERVISOR_SCHEDULE` を確認する。

| field | 意味 |
|---|---|
| `pending` | PENDING 状態の outbox row 件数 |
| `inFlight` | claim 済み (IN_FLIGHT) 件数 |
| `failed` | FAILED 状態の件数 |
| `oldestPendingAgeMs` | 最古の PENDING 行の経過 ms |
| `oldestFailedAgeMs` | 最古の FAILED 行の経過 ms |

### しきい値 (定数名)

`src/config.ts` を SSoT とする:

- `OUTBOX_METRICS_PENDING_WARN_DEPTH`: pending 件数の warn 閾値
- `OUTBOX_METRICS_PENDING_AGE_WARN_MS`: pending age の warn 閾値
- `failed > 0` も無条件で warn 昇格

これらを超過すると `level=warn` で出る。外部alert連携はアプリに持たせていないため、**Fly logs を直接確認する** こと。

## 警告対応フロー

### `failed > 0`

**意味**: `OUTBOX_MAX_ATTEMPTS` を使い切って FAILED に落ちた行がある。稼働中の定期 tick では再試行されず、同じ Session の後続は CANCELLED へ収束する。

**SOP**:

1. `fly logs` で `event=outbox.retry_scheduled` / `event=outbox.dead_letter` / `event=outbox.unsupported_payload` を遡り、原因を特定する (rate limit / 権限 / 不正 payload)
2. 原因を直した修正を deploy する。startup reconciler が本文保持中のアンケート FAILED と、それにより CANCELLED になった後続を同一 transaction で PENDING に戻し、試行回数を初期化する。手動の週取消や A/B は復帰させない
3. `event=reconciler.outbox_dead_letters_requeued` の件数を確認し、その後 `outbox.delivered` へ収束することを確認する。不正 payload を直さず再起動した場合も retry は起動ごとの 1 cycle に限定される

**禁止**: FAILED 行を手動で PENDING に戻す `UPDATE` を本番 DB に流さないこと。冪等性が壊れる。

### `pending > OUTBOX_METRICS_PENDING_WARN_DEPTH`

**意味**: dispatch が追いついていない (Discord rate limit 中 / DB 詰まり / worker が止まっている)。

**SOP**:

1. `event=rate.limited` の頻度を確認
2. `event=outbox.retry_scheduled` / `event=outbox.dead_letter` の有無を確認
3. scheduler supervisor と outbox worker が走っているか (`tick=scheduler_supervisor` / `tick=outbox_worker`) 確認
4. tick が止まっていれば case 1 (再起動) へ

### `oldestPendingAgeMs > OUTBOX_METRICS_PENDING_AGE_WARN_MS`

**意味**: 1 行が長時間 dispatch されていない。

**SOP**: pending depth と同じ flow。一行だけ古い場合は、payload 不正または FAILED 先行 intent による順序 block を構造化ログで特定する。

## Retention

専用 cron `outbox_retention` (`CRON_OUTBOX_RETENTION_SCHEDULE`) が以下を prune:

- DELIVERED 行: `OUTBOX_RETENTION_DELIVERED_MS` 超過
- FAILED / CANCELLED 行: `OUTBOX_RETENTION_FAILED_MS` 超過

pruneはアプリの保持policyで本文・配送部分・最終エラーを整理し、親のID / dedupe / 内容照合と終端状態を残す。metricsは整理済み行を除外する。最低保持期間を短縮するcutoffは受け付けず、本文整理後の古い通知を再送しない。

**PENDING / IN_FLIGHT は経過時間に関わらず絶対に削除しない** (at-least-once と message-id back-fill の正本性を保護)。

現在の cron が deploy 禁止窓を避けていることは、変更時に `src/config.ts` と運用ポリシーを突き合わせて確認する。

## Stranded outbox 対応

**症状**: PENDING / IN_FLIGHT のまま長時間 (数時間以上) 残っている。

**自動復旧**:

- IN_FLIGHT の claim が stale なら scheduler / worker / reconciler が release → 再 dispatch
- PENDING は backoff で retry される。claim token により reclaim 前の owner は結果を確定できない
- 同じ Session に FAILED の先行 intent がある PENDING は配送せず CANCELLED へ収束する
- process 起動時は FAILED とその CANCELLED 後続を一度だけ PENDING へ戻す。reconnect だけでは dead letter を復帰させない

**人手介入が必要なケース**: 原因修正が必要な FAILED のみ。**手動 UPDATE / DELETE は禁止**。修正 commit を deploy して startup recovery を走らせ、それでも残るなら payload と renderer の互換性、Discord 権限を再確認する。
