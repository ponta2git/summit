---
adr: 0042
title: Discord outbox retention — DELIVERED / FAILED 行の定期 prune
status: accepted
date: 2026-04-26
tags: [runtime, db, ops]
supersedes: []
superseded-by: null
---

# ADR-0042: Discord Outbox Retention

## TL;DR

`discord_outbox` の終端行（DELIVERED / FAILED）を**ステータス別に定期 prune** する。SSoT は `src/config.ts`（ADR-0022）。`OUTBOX_RETENTION_DELIVERED_MS` 経過の DELIVERED と `OUTBOX_RETENTION_FAILED_MS` 経過の FAILED を `CRON_OUTBOX_RETENTION_SCHEDULE` の専用 cron で削除し、テーブルの無制限成長と index 肥大化を防ぐ。FAILED は dead letter としての保持期間を DELIVERED より長く取り、運用調査の余地を残す。

## Context

ADR-0035 で導入した `discord_outbox` には終端行の retention / prune ポリシーが無く、永久に積み上がる:

- **DELIVERED**: 配送完了済み。`uq_discord_outbox_dedupe_active` の partial unique（status IN PENDING/IN_FLIGHT/DELIVERED）に含まれるため、同一 `dedupe_key` の再 enqueue を 1 行で恒久 collapse させる役割が一定期間ある。だが業務上、配送から数日経過した行は再 enqueue が来ない（週次運用のため）。
- **FAILED**: dead letter。/status の `outbox_stranded` 警告で運用者が手動対応する想定。手動対応が完了すれば保持価値は薄れる。

放置すると:
- 行数増による `idx_discord_outbox_status_next` index size と worker の `claimNextBatch` クエリコスト増。
- /status の `findStrandedOutboxEntries` クエリが古い FAILED で常時 hit して警告ノイズ化。
- バックアップ / Neon ストレージコストの線形増加。

ADR-0035 では retention / prune は明示的にスコープ外にしていたが、運用稼働後に成長が観測され始めたため policy を確定する。

## Decision

**DELIVERED / FAILED を定期削除する専用 cron `outbox_retention` を追加。**

### Retention 期間

- `DELIVERED`: `OUTBOX_RETENTION_DELIVERED_MS` 経過で削除（基準は `delivered_at`）。
- `FAILED`: `OUTBOX_RETENTION_FAILED_MS` 経過で削除（基準は `updated_at`）。
- PENDING / IN_FLIGHT は対象外（active state は reconciler / worker / `findStranded` 警告の責務範囲）。

実値は `src/config.ts`（ADR-0022）。週次運用であることから DELIVERED は直近週の audit 用、FAILED は dead letter 調査用としてより長く保持する。

### 実装

- `pruneOutbox(db, { now, deliveredOlderThan, failedOlderThan })` を `src/db/repositories/outbox.ts` に追加。`PruneOutboxResult { deliveredPruned, failedPruned }` を返す。
- `OutboxPort.prune` を追加し production / Fake で実装する。
- `src/scheduler/outboxRetention.ts` に `runOutboxRetentionTick(ctx)` を追加。`runTickSafely` で囲み、削除件数を `event=outbox.retention_pruned` で構造化ログに残す。
- 専用 cron `CRON_OUTBOX_RETENTION_SCHEDULE` で 1 日 1 回実行（時刻はオフピーク帯、deploy 禁止窓と重ならないこと）。

### 実行タイミングの選択

- **採用**: 専用 cron。低頻度・予測可能・他 tick とは独立した実装。
- **却下: outbox worker tick に同居**: 10 秒間隔で DELETE が走り、`idx_discord_outbox_status_next` への接触が無駄に頻繁。
- **却下: reconciler invariant に同居**: reconciler は observable invariant 収束が責務（ADR-0033）であり、retention は invariant ではなく policy。責務を混ぜない。
- **却下: startup のみ**: deploy 頻度が低い週は無 prune のまま走る。policy 駆動の prune は時間軸で判断すべき。

## Consequences

### Operational invariants & footguns

- **PENDING / IN_FLIGHT は絶対に prune しない**: at-least-once 配送と CAS-on-NULL back-fill（ADR-0035）の正本性が崩れる。`pruneOutbox` の WHERE 句に `status IN ('DELIVERED','FAILED')` を必ず含める。実装は status 別の 2 DELETE で混在不可能にする。
- **dedupe collision 期間の短縮**: DELIVERED 削除後は同一 `dedupe_key` の再 enqueue が partial unique に collapse されず別行になる。週次運用前提では業務上 collision は発生しない（dedupe key は session id を含む）が、新 dedupe key 設計時は retention 期間を考慮する。
- **FAILED prune 後は audit が消える**: 運用者が `/status` の `outbox_stranded` 警告を見て手動対応した記録が DB から消える。長期 forensic が必要なら別途 log 保管 / 手動 export を行う（個人開発スケールでは不要）。
- **cron 重複起動禁止**: ADR-0001 単一インスタンス前提を守る。複数プロセスで走ると DELETE 自体は冪等だが index 競合で latency が伸びる。
- **削除件数監視**: `event=outbox.retention_pruned` の `deliveredPruned` / `failedPruned` が突然桁違いに増えた場合は、worker / reconciler 側に滞留が発生していた疑いを示唆する観測点として活用する。

### 軸への影響（軸 07 / 09 / 13）

- 07 信頼性: 終端行 unbounded growth による劣化リスク解消。
- 09 ロバスト性: index コスト線形増による worker レイテンシ劣化を防ぐ。
- 13 回復性: dead letter 保持期間が明示され、運用者が handoff 期間を把握可能。

## Alternatives considered

- **TTL by partitioning** — Postgres native partition で `delivered_at` / `updated_at` 月次 partition + drop。テーブル規模（個人開発・週次・低 TPS）に対して overengineering。却下。
- **アプリ側で `pg_cron` 設定** — Neon は `pg_cron` 提供だが secret 管理範囲が増え、cron 統一性が崩れる（既存 cron は全て node-cron）。却下。
- **手動運用（ADR を起こさず ad-hoc DELETE）** — ADR-0001 の本番破壊操作禁止 + ADR-0022 SSoT 原則違反。却下。
- **DELIVERED を消さず IN_FLIGHT 保持期間のみ管理** — partial unique による dedupe collapse 効果は時間経過とともに失効する（業務上 dedupe key が再来しない）。retention で捨てて問題ない。

## Re-evaluation triggers

- DELIVERED / FAILED の保持件数が `OUTBOX_WORKER_BATCH_LIMIT × 1000` を恒常的に超える → cron 周期短縮 or partition 化検討。
- 1 回の prune で削除件数が `OUTBOX_WORKER_BATCH_LIMIT × 100` を超え DELETE latency が tick 周期を脅かす → batch 化（`LIMIT` 付き DELETE のループ）検討。
- dedupe key 設計が時間軸を跨ぐようになった場合 → DELIVERED retention 期間の見直し。

## Links

- docs/adr/0001-single-instance-db-as-source-of-truth.md
- docs/adr/0017-rejected-architecture-alternatives.md
- docs/adr/0022-ssot-taxonomy.md
- docs/adr/0033-startup-invariant-reconciler.md
- docs/adr/0035-discord-send-outbox.md
