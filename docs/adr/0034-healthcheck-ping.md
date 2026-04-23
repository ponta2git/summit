---
adr: 0034
title: Healthcheck ping strategy — boot ping + minute-tick ping
status: accepted
date: 2026-04-28
supersedes: []
superseded-by: null
tags: [runtime, ops]
---

# ADR-0034: Healthcheck ping strategy — boot ping + minute-tick ping

## TL;DR
`HEALTHCHECK_PING_URL` への ping を 2 種に分離する: プロセス起動完了で 1 度送る `boot_ping`（"起動した"）と、cron で毎分送る `tick_ping`（"生きている"）。共有ヘルパー `src/healthcheck/ping.ts` は `AbortSignal.timeout` 付き fetch を行い `PingResult` を返す純粋 utility（ログを書かない、`fetchFn` DI 可）。URL はログに出さない。未設定時は両 ping とも no-op。

## Context

`HEALTHCHECK_PING_URL`（healthchecks.io 等）はプロセス死亡・Fly.io 障害・Neon 断絶を外部検知するための死活シグナル（README §死活監視）。

I1+I2 実装は起動完了後の best-effort fetch（boot ping のみ）で、タイムアウトなし / ログなし。mid-review で 2 点指摘:

1. **M3**: boot ping に `AbortSignal.timeout` が無く Promise が永久 pending になり得る。
2. **#5**: 起動後に無音で死ぬと healthchecks.io は検知できない。README 記載の「毎分 tick ping」が未実装。

## Decision

### 2 種の ping を分離（統合しない）

- **`event=healthcheck.boot_ping`**: `run()` 末尾で 1 度送る。"プロセスが立ち上がった"。
- **`event=healthcheck.tick_ping`**: `HEALTHCHECK_PING_INTERVAL_CRON` cron で毎分。"プロセスが生きている"。
- 観測目的が異なるため**統合しない**。

### Shared helper

- `@see src/healthcheck/ping.ts` — `sendHealthcheckPing(url, { timeoutMs, fetchFn? })`。
- 純粋 HTTP utility（`AbortSignal.timeout` 付き fetch）、`PingResult` を返し**自身はログを書かない**。`fetchFn` DI 可（module mock 不要でテスト可能）。

### Secrets / Logging

- **URL をログに出さない**。残すのは `event` / `ok` / `elapsedMs` / `status` / `errorKind` のみ（`.github/instructions/secrets-review.instructions.md`、`src/logger.ts` redact）。

### SSoT

- cron 式・タイムアウト・backoff 等の実値は `src/config.ts` のみに集約（ADR-0022）。ADR/README/コメントには定数名（例: `HEALTHCHECK_PING_TIMEOUT_MS`）へのポインタのみ。

### No-op contract

- `HEALTHCHECK_PING_URL` 未設定時は **boot / tick 両方 no-op**。起動を阻害しない。

## Consequences

### Operational invariants & footguns
- **`env.HEALTHCHECK_PING_URL` 未設定時は完全 no-op** とする（起動停止しない）。ローカル / staging の未設定運用を壊すと誤検知を招く。
- production の呼び出し元は `src/index.ts` 経由で `env.HEALTHCHECK_PING_URL` と `fetchFn` を `createAskScheduler` に注入する。他経路から直接 `fetch(url)` を投げない（SRE の観測ログが `sendHealthcheckPing` + logger 前提で組まれているため）。

## Alternatives considered

- **boot ping のみ維持** — healthchecks.io は 1 回 ping では実用にならないため却下。
- **helper 内でログを書く**（`kind` で event 名切替） — 呼び出し側テストが logger スパイに依存し複雑化するため却下。返り値 `PingResult` に委ね各呼び出し元でログ。
- **cron を reminder と共用** — 頻度は同じでも観測目的が異なるため独立した `HEALTHCHECK_PING_INTERVAL_CRON` を導入、却下。
