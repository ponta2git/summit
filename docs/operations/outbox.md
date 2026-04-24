# Outbox Operations

outbox は Discord への副作用 (send / edit) を at-least-once で配送する仕組み (ADR-0035)。本ファイルは **観測値の読み方 / retention / stranded 対応** をまとめる。

関連 ADR: 0035 (outbox 設計) / 0042 (retention) / 0043 (observability metrics)
関連定数 SSoT: `src/config.ts` (定数名のみ参照、実値は SSoT 側で確認)

## 観測値 (ADR-0043)

5 分毎に `event=outbox.metrics` で出力される構造化ログ。

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

これらを超過すると `level=warn` で出る。healthchecks.io には繋がっていないので、**fly logs を直接見るか、必要なら別途 alert 経路を整備する** こと。

## 警告対応フロー

### `failed > 0`

**意味**: `OUTBOX_MAX_ATTEMPTS` を使い切って FAILED に落ちた行がある。再試行されない。

**SOP**:

1. `fly logs` で `event=outbox.dispatch.error` を遡り、原因を特定 (rate limit / 権限 / 不正 payload)
2. payload 不正 (例: `custom_id` 形式変更で旧形式が残った) なら、**FAILED 行は意図的に放置でよい** — `OUTBOX_RETENTION_FAILED_MS` (30 日) 経過で自動 prune される (ADR-0042)
3. Discord 表示が壊れているなら、reconciler invariant が次 tick で新規 outbox を積む。手動再投入は不要

**禁止**: FAILED 行を手動で PENDING に戻す `UPDATE` を本番 DB に流さないこと。冪等性が壊れる。

### `pending > OUTBOX_METRICS_PENDING_WARN_DEPTH`

**意味**: dispatch が追いついていない (Discord rate limit 中 / DB 詰まり / worker が止まっている)。

**SOP**:

1. `event=rate.limited` の頻度を確認
2. `event=outbox.dispatch.error` の有無を確認
3. cron tick が走っているか (`event=tick, name=outbox_dispatch`) 確認
4. tick が止まっていれば case 1 (再起動) へ

### `oldestPendingAgeMs > OUTBOX_METRICS_PENDING_AGE_WARN_MS`

**意味**: 1 行が長時間 dispatch されていない。

**SOP**: pending depth と同じ flow。一行だけ古い場合は payload 不正の可能性が高いので `event=outbox.dispatch.error` で特定。

## Retention (ADR-0042)

専用 cron `outbox_retention` (`CRON_OUTBOX_RETENTION_SCHEDULE`、4:00 JST) が以下を prune:

- DELIVERED 行: `OUTBOX_RETENTION_DELIVERED_MS` (7d) 超過
- FAILED 行: `OUTBOX_RETENTION_FAILED_MS` (30d) 超過

**PENDING / IN_FLIGHT は経過時間に関わらず絶対に削除しない** (at-least-once と CAS-on-NULL back-fill の正本性を保護)。

スケジュールを 4:00 JST にしているのは deploy 禁止窓 (金 17:30〜土 01:00) を回避するため。

## Stranded outbox 対応

**症状**: PENDING / IN_FLIGHT のまま長時間 (数時間以上) 残っている。

**自動復旧**:

- IN_FLIGHT の claim 時刻が `OUTBOX_CLAIM_DURATION_MS` (30s) より stale なら次 tick で release → 再 dispatch
- PENDING は backoff で retry されるので待つ

**人手介入が必要なケース**: ない。**手動 UPDATE / DELETE は禁止**。どうしても消したいときは Fly redeploy で reconciler を再走させ、それでも残るなら原因 (payload 不正 / Discord 側削除) を特定して修正コミットを入れる。
