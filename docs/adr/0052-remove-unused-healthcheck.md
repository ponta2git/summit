---
adr: 0052
title: 未使用 healthcheck 外部連携の撤去
status: accepted
date: 2026-08-08
supersedes: [0034]
superseded-by: null
tags: [runtime, ops, docs]
---

# ADR-0052: 未使用 healthcheck 外部連携の撤去

## TL;DR

利用予定のない外部 healthcheck ping をアプリから撤去する。関連する runtime、環境変数、scheduler 登録、secret redaction、テスト、運用文書を削除し、通常の運用観測は構造化ログと `/status` に集約する。

## Context

ADR-0034 で導入した boot/tick ping は現在の運用で利用されておらず、外部 endpoint、secret、fetch 失敗処理、scheduler 経路を維持するコストだけが残っている。未使用機能を残すと設定の誤投入、監視先の不整合、削除対象の見落としを招く。

## Decision

- healthcheck ping の実装、boot 呼び出し、scheduler tick、関連する環境変数・設定値・secret redaction を削除する。
- healthcheck 専用テストと、healthcheck の存在を前提にした scheduler/env/logger のテスト期待値を削除する。
- 運用観測は構造化ログと `/status` を用いる。外部監視サービスを導入する場合は、アプリ内の暗黙の副作用としてではなく別途責務・通知経路・障害時手順を ADR で定める。
- ADR-0034 は本決定で superseded とし、履歴として本文を保持する。

## Consequences

### Positive

- 未使用の外部通信、secret、scheduler task、起動時副作用がなくなる。
- runtime の設定面とテスト対象が小さくなり、healthcheck 設定の drift を防げる。

### Accepted risk

- healthchecks.io 等の外部サービスによる自動 alert は発生しなくなる。異常時は Fly logs、`/status`、既存の運用手順で確認する。

## Alternatives considered

- **no-op のまま維持** — 設定・依存・テスト・運用説明の負債が残るため却下。
- **別の外部監視へ即時置換** — 今回の利用予定がなく、監視サービスの選定・通知設計を含む別スコープのため却下。

## Re-evaluation triggers

外部からの死活監視や SLO 通知が必要になった場合は、監視対象、通知先、単一インスタンス運用との整合、障害時 runbook を定義した新 ADR で再評価する。

## Links

- @see ADR-0034
- @see ADR-0001
