---
adr: 0047
title: DB-driven conditional scheduler for Neon scale-to-zero
status: accepted
date: 2026-04-25
supersedes: []
superseded-by: null
tags: [runtime, db, discord, ops]
---

# ADR-0047: DB-driven conditional scheduler

## TL;DR

高頻度の空 tick を常時登録せず、DB の次作業時刻と outbox の次配送時刻から one-shot timer / burst worker を再構築する scheduler controller を採用する。Fly Bot は Discord Gateway 即時応答のため常時起動し、Neon の scale-to-zero を妨げる idle DB polling だけを削減する。

## Context

従来の scheduler は reminder / outbox worker / outbox metrics を固定 cron として常時登録していた。各 tick は冪等だが、作業が無い平日でも DB を定期的に read するため、Neon compute が idle に落ちにくい。

この Bot の業務利用は週末近辺に偏る一方、平日の `/ask` や将来の任意日 ask flow も成立させたい。単純な曜日限定 cron は平日フローに弱く、DB を正本とする既存原則とも相性が悪い。

Discord Bot は HTTP request で起動できる Web app ではなく、Gateway WebSocket を維持して interaction を受ける。Fly Machine を止めると平日の `/ask` / button を即時受信できない。

## Decision

`src/scheduler/controller.ts` に DB-driven scheduler controller を導入する。

- `createAskScheduler()` は固定 cron を calendar ask / healthcheck / outbox retention / supervisor に絞る。実値は `src/config.ts` の `CRON_*` / `SCHEDULER_*` / `OUTBOX_*` 定数を SSoT とする。
- `SessionsPort.getSchedulerSessionHints()` は進行中セッションの次締切と次 reminder 時刻を返す。過去時刻も返し、controller が即時収束させる。
- `OutboxPort.getNextDispatchAt()` は未配送 row の次試行時刻と claim expiry から、次に worker attention が必要な時刻を返す。
- controller は DB hint から one-shot timer を張り、期限到達時に既存 tick 関数を `runTickSafely` 経由で実行する。
- outbox は常時 tick ではなく、配送可能 row がある間だけ burst worker を起動する。配送後は次の outbox 時刻を再読込し、作業が無ければ停止する。
- interaction / orchestration 境界から `wakeScheduler(reason)` を呼び、手動 `/ask` や button 由来の状態変化を supervisor 待ちにしない。
- startup / reconnect は従来どおり DB から回復し、その後 controller を wake して in-memory timer を再構築する。
- Fly Bot は常時起動を維持する。Scheduled Fly stop/start は採用しない。

## Consequences

### Operational invariants

- in-memory timer は hint であり正本ではない。process restart / reconnect / missed wake は startup recovery と supervisor で DB から再構築する。
- supervisor cadence は missed wake の最大回復遅延と Neon wakeup 回数の trade-off。実値は `CRON_SCHEDULER_SUPERVISOR_SCHEDULE` を確認する。
- outbox delivery は通常 interaction wake で即時寄りに始まるが、wake が失われた場合は supervisor が上限遅延になる。
- stale reminder claim と expired outbox claim は supervisor / startup / reconnect の回復対象として残す。
- Fly Machine を止めないため、Discord interaction の即時受信性は維持される。コスト削減の主対象は Neon compute。

### Follow-up obligations

- Neon Console で compute hours を確認し、supervisor cadence が scale-to-zero を阻害していないか観測する。
- outbox metrics の頻度・警告運用は fixed high-frequency tick 前提から supervisor 前提へ runbook を更新する。
- 新しい outbox enqueue 経路や状態遷移 flow を追加したら、handler / orchestration 境界で scheduler wake を呼ぶ。

## Alternatives considered

- **曜日限定 cron** — 金土以外の手動 `/ask` / 将来の任意日フローに弱く、DB 状態から再構築する原則とずれるため却下。
- **Fly Machine の平日 stop/start** — Fly compute 削減幅が小さい一方、停止中は Discord Gateway interaction を受信できないため既定運用として却下。
- **現状維持** — 空 tick が Neon compute の scale-to-zero を妨げ、低頻度 Bot の費用対効果が悪いため却下。
- **外部キュー / 外部 scheduler** — 単一インスタンス・低頻度用途に対して運用複雑度が高く、DB hint + in-process timer で十分なため却下。

## Re-evaluation triggers

- 平日利用が増え、supervisor 待ちの最大遅延が実害になったとき。
- Neon billing / scale-to-zero 挙動が変わり、低頻度 supervisor でも compute が常時起動になるとき。
- Fly に Discord Gateway bot を安全に event-driven wake できる仕組みが追加されたとき。
- 複数インスタンス運用へ移行する必要が出たとき。

## Links

- docs/adr/0001-single-instance-db-as-source-of-truth.md
- docs/adr/0024-reminder-dispatch.md
- docs/adr/0033-startup-invariant-reconciler.md
- docs/adr/0035-discord-send-outbox.md
- docs/adr/0043-outbox-observability-metrics.md
- docs/adr/0046-user-facing-configuration-file.md
