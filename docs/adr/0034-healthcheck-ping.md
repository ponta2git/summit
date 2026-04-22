---
adr: "0034"
title: Healthcheck ping strategy — boot ping + minute-tick ping
status: accepted
date: 2026-04-28
supersedes: []
superseded-by: null
tags: [runtime, ops]
---

# ADR-0034: Healthcheck ping strategy — boot ping + minute-tick ping

## Context

`HEALTHCHECK_PING_URL` (e.g. healthchecks.io) は、プロセス死亡・Fly.io 障害・Neon 断絶を
外部から検知するための死活監視シグナルとして要件に挙がっている (README §死活監視)。

I1+I2 実装では起動完了後に best-effort でフェッチするのみ（boot ping のみ）で、タイムアウトなし・
ログなしだった。mid-review でふたつの課題が指摘された:
1. **Primary M3**: boot ping に `AbortSignal.timeout` がなく Promise が永久 pending になり得る。
2. **Second-opinion #5**: プロセスが起動後に無音で死んでも healthchecks.io は検知できない。
   README には「毎分 tick ping」と記載があるが実装が存在しなかった。

## Decision

1. **boot ping と tick ping を分離する。**
   - `event=healthcheck.boot_ping`: プロセス起動完了（`run()` 末尾）に 1 度だけ送る。"プロセスが立ち上がった" シグナル。
   - `event=healthcheck.tick_ping`: `HEALTHCHECK_PING_INTERVAL_CRON` cron で毎分送る。"プロセスが生きている" シグナル。
   - 二つを統合しない。異なる観測目的を持つ独立したシグナルである。

2. **共有ヘルパー `src/healthcheck/ping.ts`** に `sendHealthcheckPing(url, { timeoutMs, fetchFn? })` を置く。
   - 純粋 HTTP ユーティリティ。`PingResult` を返し、自身はログを書かない。
   - `fetchFn` を DI 可能にし、テストでモジュールモックなしに検証できるようにする。

3. **タイムアウト値と cron 式は `src/config.ts` の定数に集約。** 実値 (秒・cron 式等) は ADR/README/コメントに書き写さず、定数名への pointer のみ置く (ADR-0022)。タイムアウト定数名: `HEALTHCHECK_PING_TIMEOUT_MS`。

4. **URL はログに出さない。** `event`, `ok`, `elapsedMs`, `status`/`errorKind` のみログに残す。
   (`.github/instructions/secrets-review.instructions.md` / `src/logger.ts` の `redact` パス)

5. **HEALTHCHECK_PING_URL 未設定時は両 ping とも no-op。** プロセス起動を阻害しない。

6. **cron 式 / タイムアウト値 / 定数は `src/config.ts` のみが SSoT** (ADR-0022)。
   ADR/README/コメントには値を書き写さず、定数名へのポインタのみ置く。

## Consequences

- `createAskScheduler` の `deps` に `healthcheckUrl?: string` / `fetchFn?: FetchFn` を追加した。
  production は `src/index.ts` の呼び出し元が `env.HEALTHCHECK_PING_URL` を渡す。
- `src/scheduler/index.ts` のタスク数が 4 → 5 に増えた（既存の cron テストを合わせて更新）。
- boot ping が `fetch(url)` の fire-and-forget から `sendHealthcheckPing` + `.then(logger.info/warn)` に変わり、
  成否が観測可能になった (Primary M3 解消)。
- `tests/scheduler/healthcheck.test.ts` に DI ベースのテストを追加した。

## Alternatives considered

- **boot ping のみ維持**: healthchecks.io は "1 回だけ ping" では実用にならない。reject。
- **helper 内でログを書く**: `kind` パラメータで `event` 名を切り替える案。呼び出し側のテストが logger のスパイに依存し複雑化するため reject。返り値 (`PingResult`) に委ね、各呼び出し元がログを書く設計を採用。
- **cron を reminder と共用**: `CRON_REMINDER_SCHEDULE` ("* * * * *") と同じ頻度だが、
  観測目的が異なるため独立した `HEALTHCHECK_PING_INTERVAL_CRON` 定数を導入した。
