---
adr: 0033
title: 起動時および tick 境界での invariant 収束 (startup / tick reconciler)
status: accepted
date: 2026-04-28
supersedes: []
superseded-by: null
tags: [runtime, db, discord, ops]
---

# ADR-0033: 起動時および tick 境界での invariant 収束 (startup / tick reconciler)

## Context

- 2026-04-21 レビュー (`docs/reviews/2026-04-21/final-report.md`) で以下 3 件が収束経路のない invariant 違反として挙がった:
  - **C1**: `CANCELLED` は ADR-0001 で「短命中間状態」と定義されているが、`cancelAsking` → 次状態 (`startPostponeVoting` / `completeCancelledSession`) の間でプロセスが落ちると宙づりの `CANCELLED` 行が残る。
  - **N1**: `createAskSession` 成功後に Discord `channel.send` が失敗した場合、`askMessageId=NULL` のまま `(weekKey, postponeCount)` unique 制約で再作成不能になる。同じく Discord 側で message が削除 (`Unknown Message` / code 10008) された場合、再編集経路でも回復できない。
  - **H1**: `claim-first` (ADR-0024) が `reminder_sent_at=now` を立てた直後の crash で claim が永久に stuck する。
- 既存の `runStartupRecovery` は「締切超過の ASKING / POSTPONE_VOTING を再決着する」範囲に限定され、上記 3 件は扱わない。
- DB を正本とする invariant (ADR-0001) を維持しつつ、プロセス再起動でも自動的に収束する単一の入口が必要。

## Decision

- `src/scheduler/reconciler.ts` に以下 5 つの invariant を冪等に収束させる `runReconciler(client, ctx, { scope })` を新設する:
  - **A. 宙づり CANCELLED の次状態促進** (C1): 金曜回かつ順延期限前は `POSTPONE_VOTING` へ、金曜回かつ順延期限後および土曜回は `completeCancelledSession` で `COMPLETED` へ収束。`CANCELLED → SKIPPED` は `SESSION_ALLOWED_TRANSITIONS` に存在しないため終端は `COMPLETED` を採用する。
  - **B. 週次 ASKING session の欠落検出** (N1): 金曜の ask 窓内 (cron 送信時刻以降、`ASK_DEADLINE_HHMM` 以前) に `(weekKey, postponeCount=0)` が無ければ通常経路 `sendAskMessage` で作成する。窓外は何もしない。
  - **C. `askMessageId=NULL` の復旧** (N1): `ASKING` / `POSTPONE_VOTING` / `POSTPONED` のいずれかで `askMessageId` が NULL の session に対し、現在の viewModel から再投稿し ID を保存する。土曜回 (`postponeCount=1`) は専用経路 `sendPostponedAskMessage` を使う。
  - **D. Discord message 削除 (10008) の検出** (N1): `updateAskMessage` が `Unknown Message` (`RESTJSONErrorCodes.UnknownMessage` = 10008) を受け取ったら新規投稿して `askMessageId` を差し替える。
  - **E. stale reminder claim の reclaim** (H1): `reminder_sent_at` が閾値より古い `DECIDED` 行を `revertReminderClaim` で NULL に戻す。閾値は `src/config.ts` の `REMINDER_CLAIM_STALENESS_MS`。
- スコープは 2 つ:
  - `scope: "startup"`: A〜C および E を順に実行。`src/index.ts` で `client.login()` 後・scheduler 登録前に 1 度呼ぶ。phase ログに件数を添える (`phase: "reconcile"`, `bootId`, `elapsedMs`, 件数フィールド)。
  - `scope: "tick"`: E のみ実行。`runReminderTick` の冒頭で呼び、毎分 tick でも stale claim を回収する。A〜C は Discord API 呼び出しを伴うため毎分流すコストに見合わず、起動時のみ。
- 起動フェーズを構造化ログで観測可能にする: `boot_start` → `db_connect` → `login` → `reconcile` → `ready`。各ログに `event: "boot.phase"`, `phase`, `bootId` (プロセス起動時に 1 回生成), `elapsedMs` を含める。
- `SessionsPort` に 2 つのクエリを追加する:
  - `findStrandedCancelledSessions()`: `status='CANCELLED'` の全件。
  - `findStaleReminderClaims(olderThan)`: `status='DECIDED' AND reminder_sent_at <= olderThan`。
- すべての収束ログは `event=reconciler.*` 名前空間を使い、運用時に grep / ログ分析から容易に抽出できる形にする。

## Consequences

- **回復の自動化**: プロセス落ち・rolling restart 後に operator 介入なしで DB と Discord を invariant に戻せる。`fly ssh` での手動 `UPDATE` を必要としない (AGENTS.md 禁止領域を守る)。
- **冪等性の維持**: 各 invariant は edge-specific state API (ADR-0001, Phase I1) の CAS 契約に依存するため、scheduler tick と reconciler が同時走行しても race lost になるだけで副作用は起きない。
- **可観測性の向上**: `boot.phase` ログで起動の停止地点 (DB 接続 / login / reconcile) が切り分け可能になり、`reconciler.*` ログで収束頻度を監視できる。運用異常 (頻発する `cancelled_promoted` など) の検知が可能。
- **tick scope の意図的な縮小**: A〜C を毎分走らせない代わりに、`askMessageId=NULL` など Discord-side の不整合はプロセス再起動まで放置される可能性がある。この範囲は運用上許容し、必要になったら Phase I3 (outbox pattern) で常時監視に昇格させる。
- **`CANCELLED → COMPLETED` を選択した影響**: 「路が無いなら SKIPPED」と書いた初期案に対し、`SESSION_ALLOWED_TRANSITIONS` との整合性から `COMPLETED` を採用した。`SKIPPED` は `/cancel_week` の意味論 (意図的なキャンセル) を保持する。
- **新規ポートメソッド追加**: `findStrandedCancelledSessions` / `findStaleReminderClaims` は real / fake の双方に実装が必要。`AppContext` 経由 (ADR-0018) で注入するためテスト経路は壊さない。
- **設定値の SSoT**: `REMINDER_CLAIM_STALENESS_MS` は `src/config.ts` のみを正本とする (ADR-0022)。本 ADR 本文には具体値を書かない。

## Alternatives considered

- **outbox パターンで Discord 送信を永続化**: N1 を根本的に解決するが、投稿履歴の persistence layer を別途必要とし設計規模が大きい。Phase I3 (`p1-outbox`) で別途検討する。本 ADR は「再起動で収束する」最小の自動化に留める。
- **reconciler を節操なく毎 tick 呼ぶ**: 実装は単純だが、A (stranded CANCELLED) / B (missing ASK) は Discord API を叩くため rate limit と余計な edit 呼び出しが発生する。起動時限定に限る。
- **tick scope も廃して startup のみ**: プロセスが再起動しない限り stale claim が残る。H1 はプロセス生存中も起こり得る (claim → send → crash pattern 不完全時) ため tick scope を残す。
- **`CANCELLED` の promotion を業務 settle 関数へ寄せる**: `settleAskingSession` は `ASKING → CANCELLED` が起点のため、CANCELLED 入力を扱わない。reconciler 側で「CANCELLED からの promotion」だけを持つのが責務の観点で明瞭。

## 参照

- `docs/reviews/2026-04-21/final-report.md` §1 C1 / N1, §2 H1, §5 Fix Sequencing (Phase I1)
- `docs/adr/0001-single-instance-db-as-source-of-truth.md`
- `docs/adr/0003-postgres-drizzle-operations.md`
- `docs/adr/0018-port-wiring-and-factory-injection.md`
- `docs/adr/0024-reminder-dispatch.md` (Consequences を本 ADR 採択に合わせて更新)
- 実装値の SSoT: `src/config.ts` (`REMINDER_CLAIM_STALENESS_MS`, `ASK_DEADLINE_HHMM`, `POSTPONE_DEADLINE_HHMM`)
