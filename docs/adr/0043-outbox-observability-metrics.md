---
adr: 0043
title: Outbox observability metrics with periodic structured logging
status: accepted
date: 2026-04-25
tags: [ops, db]
supersedes:
superseded-by:
---

## TL;DR

Outbox の `pending` / `inFlight` / `failed` 件数と最古 PENDING/FAILED の経過時間を、5 分毎の専用 cron `outbox_metrics` で構造化ログ (`event=outbox.metrics`) に出力する。閾値超過 (`failed > 0` / `pending > 50` / `oldestPendingAgeMs > 5min`) で `level=warn` に昇格させ、観測可能性を担保する。

## Context

ADR-0035 (outbox) と ADR-0042 (retention) で配送と prune は確立した。一方、運用中に「いま outbox がどの程度滞留しているか」「最古の PENDING がいつから retry を続けているか」を確認する手段は `/status` slash command の手動実行しかなく、能動的観測性が欠けていた。レビュー軸 07/09/13 (Reliability / Robustness / Recoverability) で H 優先として指摘 (H-2)。

採用しなかった選択肢:

- **Worker tick (10s) で毎回 emit**: ~8640 logs/day と過剰。ノミナル状態のノイズで warn シグナルが埋もれる
- **Reconciler (30s) で同居**: invariant 収束ロジックと観測責務が混線。ADR-0039 の関心分離方針と矛盾
- **Prometheus / OpenTelemetry エクスポータ**: 単一インスタンス + 4 ユーザー規模に対し過剰。Fly logs + healthchecks.io の現行スタックで十分
- **`/status` の能動 polling 自動化**: Discord 経由は rate-limit と Bot 自身への通知ループになる

## Decision

1. **専用 cron `outbox_metrics`** を導入し `*/5 * * * *` (5 分毎) で `runOutboxMetricsTick` を実行する。
2. 取得項目は `pending` / `inFlight` / `failed` 件数 + `oldestPendingAgeMs` / `oldestFailedAgeMs`。DELIVERED は ADR-0042 の retention で逐次 prune され観測価値が小さいため除外。
3. ログイベント名は `outbox.metrics`。always emit (depth=0 でも info で出す) し、ベースライン可観測性を担保する。
4. **warn 昇格条件** (OR):
    - `failed > 0` (dead letter 発生)
    - `pending > OUTBOX_METRICS_PENDING_WARN_DEPTH` (= 50)
    - `oldestPendingAgeMs > OUTBOX_METRICS_PENDING_AGE_WARN_MS` (= 5 分)
5. しきい値 / cron 表現はすべて `src/config.ts` を SSoT とする (ADR-0022)。本 ADR には数値を再記載しない。
6. SQL は `count(*) GROUP BY status` 1 本 + `min(createdAt) WHERE status='PENDING'` / `min(updatedAt) WHERE status='FAILED'` の 3 クエリで取得する (索引: 既存の `(status, next_attempt_at)` で十分カバー)。

## Consequences

- 観測性が能動化し、`/status` 手動確認に依存せず Fly logs ベースで滞留検知できる
- info レベルで ~288 logs/day 増加するが pino redact 対象外でサイズも数百 byte/log と運用許容内
- warn 昇格時は既存の logger.warn がそのまま healthchecks.io 連携や将来の log-based alert で利用可能
- 閾値はあくまで初期値であり、運用実績に応じ `src/config.ts` で調整する (ADR 改訂不要)
- メトリクス取得は worker / retention / reconciler と完全独立で、failure 隔離 (try/catch in tick) により他経路に影響しない

## Re-evaluation triggers

- 4 ユーザー固定運用が変わり、トラフィックが日次 1000 件規模を超えるなど大幅に拡大した場合 → メトリクスストア (Prometheus 等) への移行を再検討
- Fly logs の検索性が破綻するレベルで info ログが増えた場合 → emit を「depth>0 OR warn のみ」に絞る
- warn 閾値が誤検知 / 検知漏れを連発する場合 → `OUTBOX_METRICS_*` 定数を調整 (ADR 改訂不要)

## Links

- ADR-0022 (SSoT for executable literals)
- ADR-0035 (outbox model)
- ADR-0039 (scheduler / reconciler separation)
- ADR-0042 (outbox retention prune)
- 2026-04-24 quality review H-2 (axes 07/09/13)
- `src/config.ts` — `OUTBOX_METRICS_PENDING_WARN_DEPTH` / `OUTBOX_METRICS_PENDING_AGE_WARN_MS` / `CRON_OUTBOX_METRICS_SCHEDULE`
- `src/scheduler/outboxMetrics.ts`
- `src/db/repositories/outbox.ts` — `getOutboxMetrics`
