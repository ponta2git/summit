---
adr: 0050
title: Scheduler supervisor cadence extension
status: accepted
date: 2026-05-19
supersedes: []
superseded-by: null
tags: [runtime, db, ops]
---

# ADR-0050: Scheduler supervisor cadence extension

## TL;DR

DB-driven scheduler supervisor の idle fallback cadence を延ばし、Neon compute の不要な wakeup をさらに抑える。実行値は `src/config.ts` の `CRON_SCHEDULER_SUPERVISOR_SCHEDULE` を唯一の SSoT とする。

## Context

ADR-0047 で high-frequency な空 tick を廃止し、DB hint から one-shot timer / burst worker を再構築する controller を導入した。残る定期 DB read は missed wake / timer 消失の fallback である scheduler supervisor が中心になっている。

通常経路では startup / reconnect / interaction / orchestration が scheduler を wake するため、supervisor は即時性の主経路ではない。supervisor cadence は missed wake 時の最大回復遅延と Neon wakeup 回数の trade-off であり、現状の個人 Bot 運用ではコスト・idle 性を優先できる。

## Decision

`CRON_SCHEDULER_SUPERVISOR_SCHEDULE` の cadence を延ばす。scheduler supervisor は引き続き `runReconciler(scope="tick")`、outbox claim reclaim、controller recompute を実行する fallback として残す。

新しい状態遷移・outbox enqueue・手動 command 経路は、supervisor 待ちにせず `wakeScheduler(reason)` を呼ぶ前提を維持する。

## Consequences

- missed wake / timer 消失時の最大自動回復遅延は長くなる。
- idle 時の DB read 頻度が下がり、Neon compute が scale-to-zero へ戻る余地が増える。
- outbox delivery / reminder / deadline の通常経路は one-shot timer と explicit wake に依存するため、wake wiring の回帰がより見えにくくなる。scheduler 関連変更では `scheduler.wake_requested` と `scheduler_supervisor` の両方を確認する。
- outbox metrics は scheduler supervisor tick 内で出るため、観測粒度も同じ cadence に従う。

## Alternatives considered

- **既存 cadence の維持** — fallback 回復は早いが、低頻度 Bot では idle DB read の削減余地が残るため却下。
- **supervisor 廃止** — missed wake / timer 消失の自動回復経路を失い、DB 正本からの収束性が弱くなるため却下。
- **曜日限定 supervisor** — 平日 command / 将来の任意日 flow に弱く、DB-driven controller の方針とずれるため却下。

## Re-evaluation triggers

- missed wake 由来の配送遅延や deadline 処理遅延が実害になったとき。
- Neon billing / scale-to-zero 挙動が変わり、この cadence 変更による効果が薄れたとき。
- wake wiring を必須化できない新しい外部入力経路を追加するとき。

## Links

- docs/adr/0047-db-driven-conditional-scheduler.md
- src/config.ts
- src/scheduler/controller.ts
