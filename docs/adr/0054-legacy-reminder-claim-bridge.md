---
adr: 0054
title: 旧 reminder claim marker の outbox 移行互換
status: accepted
date: 2026-08-08
supersedes: []
superseded-by: null
tags: [runtime, db, discord, ops, docs, testing]
---

# ADR-0054: 旧 reminder claim marker の outbox 移行互換

## TL;DR

旧 claim-first 経路が残した `DECIDED` の reminder marker は migration で書き換えず、新 outbox 経路の曖昧な送信として再配送する。これにより監査値を保持しつつ、未送信の reminder 欠落を防ぐ。

## Context

ADR-0051 は旧 reminder claim を廃止し、配送成功と `DECIDED → COMPLETED` を outbox 完了処理へまとめた。旧経路では Discord 呼び出し前に marker を書いていたため、プロセス停止のタイミングによっては `DECIDED` と marker が同居する。

この状態を migration で NULL に戻すと監査値を失い、送信済みだった場合は重複を招く。一方、marker を理由に新 scheduler が無視すると未送信 reminder が永久に欠落する。

## Decision

1. migration は旧 `DECIDED` reminder marker を変更せず保持する。
2. `DECIDED` かつ reminder due の行は marker の有無によらず outbox へ enqueue する。
3. outbox の dedupe と worker の `DECIDED → COMPLETED` transaction を送信の収束境界とし、外部送信が曖昧な場合は重複を許容して欠落を避ける。

## Consequences

- 既存の audit marker と本番 DB の値を migration が破壊しない。
- 旧 claim が実際には Discord 受理済みだった場合、移行後に reminder が重複する可能性がある。
- `DECIDED` の due 判定は marker ではなく status と reminderAt を使う。新方式の完了 marker は `COMPLETED` と同じ transaction で保存される。
- 0017 migration の duplicate dedupe key と未対応 outbox kind の guard は引き続き fail-closed とし、別のデータ修復判断をこの互換策に混ぜない。

## Alternatives considered

- **migration で marker を NULL に戻す** — 既存の監査値を失い、migration に本番 business state の修復責務を持ち込むため却下。
- **旧 marker を残して scheduler の対象外にする** — 曖昧な送信の recovery がなく、reminder 欠落を永続化するため却下。
- **旧 marker 行を手動 UPDATE で修復する** — DB 正本の運用原則と migration の再現性を壊すため却下。

## Links

- [ADR-0051](./0051-session-aggregate-ordered-discord-intents.md)
- [Migration Operations](../operations/migration.md)
