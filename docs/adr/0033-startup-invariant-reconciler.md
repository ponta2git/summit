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

## TL;DR
`src/scheduler/reconciler.ts` の `runReconciler(client, ctx, { scope })` が 5 invariant を冪等に収束させる: A. 宙づり `CANCELLED` の次状態促進（C1）、B. 週次 ASK session の欠落検出（N1）、C. `askMessageId=NULL` の復旧（N1）、D. Discord `Unknown Message` 検出時の再投稿（N1）、E. stale reminder claim の reclaim（H1）。`scope="startup"` は A〜C + E、`scope="tick"` は E のみ。起動時は `interactionCreate` を reconciler + recovery 完了まで gate する。

## Context

収束経路のない invariant 違反 3 件が内部レビューで挙がった:

- **C1（宙づり CANCELLED）**: ADR-0001 で「短命中間状態」と定義された `CANCELLED` が、`cancelAsking` → 次状態（`startPostponeVoting` / `completeCancelledSession`）の間でプロセス落ちすると残留する。
- **N1（ask publication gap）**: `createAskSession` 成功後に `channel.send` が失敗すると `askMessageId=NULL` のまま `(weekKey, postponeCount)` unique で再作成不能。Discord 側 message 削除（`Unknown Message` / 10008）も再編集経路で回復不能。
- **H1（stale reminder claim）**: `claim-first`（ADR-0024）が `reminder_sent_at=now` を立てた直後の crash で claim が永久 stuck。

既存 `runStartupRecovery` は締切超過 ASKING / POSTPONE_VOTING の再決着のみを扱い、上記 3 件は範囲外。DB 正本（ADR-0001）を維持したままプロセス再起動で自動収束する単一入口が必要。

## Decision

`src/scheduler/reconciler.ts` に `runReconciler(client, ctx, { scope })` を新設。DB を正本に 5 invariant を冪等に収束させる。

### Invariants（probes）

- **A. 宙づり `CANCELLED` の次状態促進**（C1）: 金曜回かつ順延期限前 → `POSTPONE_VOTING` へ。金曜回かつ順延期限後および土曜回 → `completeCancelledSession` で `COMPLETED` へ。`CANCELLED → SKIPPED` は `SESSION_ALLOWED_TRANSITIONS` に不在のため終端は **`COMPLETED`**（`SKIPPED` は `/cancel_week` の意図的キャンセル語彙として温存）。
- **B. 週次 ASKING の欠落検出**（N1）: 金曜の ask 窓内（cron 送信時刻以降、`ASK_DEADLINE_HHMM` 以前）に `(weekKey, postponeCount=0)` 不在なら通常経路 `sendAskMessage` で作成。窓外は何もしない。
- **C. `askMessageId=NULL` の復旧**（N1）: `ASKING` / `POSTPONE_VOTING` / `POSTPONED` で NULL の session に現 viewModel で再投稿し ID 保存。土曜回（`postponeCount=1`）は `sendPostponedAskMessage` 経路。
- **D. Discord `Unknown Message` (10008) 検出**（N1）: `updateAskMessage` が `RESTJSONErrorCodes.UnknownMessage` を受けたら新規投稿して `askMessageId` 差し替え。
- **E. stale reminder claim の reclaim**（H1）: `reminder_sent_at` が `REMINDER_CLAIM_STALENESS_MS` より古い `DECIDED` 行を `revertReminderClaim` で NULL へ戻す。

### Scope

- **`scope: "startup"`**: A〜C + E を順に実行。`src/index.ts` で `client.login()` 後・scheduler 登録前に 1 度。
- **`scope: "tick"`**: **E のみ**。`runReminderTick` 冒頭で毎分実行。A〜C は Discord API を伴うため毎分は不経済、起動時限定。

### Concurrency / Safety

- **冪等性**: 各 invariant は edge-specific state API（ADR-0001, Phase I1）の CAS 契約に従う。scheduler tick と reconciler が同時走行しても race lost で無害。
- **interaction gate**: `src/index.ts` の ready signal は `runReconciler(scope="startup")` + `runStartupRecovery()` 完了まで `interactionCreate` dispatcher を gate（未収束期間で DB 変更を受け付けない）。
- **新規 Port メソッド**: `SessionsPort.findStrandedCancelledSessions()`（`status='CANCELLED'` 全件）、`findStaleReminderClaims(olderThan)`（`status='DECIDED' AND reminder_sent_at <= olderThan`）。real / fake 双方に実装（ADR-0018）。

### Observability

- 起動フェーズログ: `boot_start` → `db_connect` → `login` → `reconcile` → `ready`。各に `event: "boot.phase"` / `phase` / `bootId`（プロセス起動時 1 回生成）/ `elapsedMs` を含める。
- 収束ログは **`event=reconciler.*`** 名前空間（grep / 分析で抽出容易）。`phase: "reconcile"` は件数フィールドを添える。

### SSoT

- `REMINDER_CLAIM_STALENESS_MS` / `ASK_DEADLINE_HHMM` / `POSTPONE_DEADLINE_HHMM` は `src/config.ts` が唯一の正本（ADR-0022）。ADR 本文に値を書き写さない。

### Outbox 連携（ADR-0035）

`runReconciler(scope="startup")` に `reconcileOutboxClaims` を追加し、`claim_expires_at` 超過の `IN_FLIGHT` を `PENDING` に戻す。active probe は外部削除、outbox は送信経路自体の at-least-once を救う**異なる invariant**（両立）。

## Consequences

### Follow-up obligations
- `askMessageId=NULL` など Discord-side の不整合は tick scope に載せていない（tick = E only）。プロセス再起動までは放置される運用を許容する。常時監視が必要になった段階で ADR-0035 outbox の coverage 拡張で昇格させる。
- 新設 port メソッド（`findStrandedCancelledSessions` / `findStaleReminderClaims`）は real / fake の双方に実装を保つ。`AppContext` 経由の注入（ADR-0018）を壊さない。

### Operational invariants & footguns
- **scope split を混同しない**: startup scope = invariants A–C + E、tick scope = E only。tick で A–C を走らせると Discord API の無駄撃ちと rate-limit 消費を招く（@see Decision ### Scope）。
- **runTickSafely の consumer 呼び分け**: 起動経路は `runReconciler(scope="startup")`、定期 tick は `runReconciler(scope="tick")`、reconnect 経路は `scope="reconnect"`（ADR-0036）。呼び分けを誤ると scope 契約が崩れる。
- **外部 delete 検知と send-path at-least-once を混同しない**: reconciler の A/B probe は Discord から delete された message を再送・再描画する経路、outbox worker の at-least-once は `dedupe_key` による別レイヤーの保証。reconciler から outbox へ直接 enqueue しない。
- ログ namespace: `boot.phase` で DB 接続 / login / reconcile の停止地点を切り分け、`reconciler.*` で収束頻度（`cancelled_promoted` 頻発など）を監視する。grep 容易な固定 namespace を崩さない。
- 設定値（`REMINDER_CLAIM_STALENESS_MS` ほか）の SSoT は `src/config.ts`（ADR-0022）。本 ADR 本文・コメントに具体値を書き写さない。

## Alternatives considered

- **outbox パターンで Discord 送信を永続化** — N1 を根本解決するが persistence layer が別途必要で設計規模が大きく、Phase I3 (`p1-outbox`) に先送りし本 ADR は起動時収束に留めるため却下。
- **reconciler を毎 tick 呼ぶ** — A/B 分岐が Discord API を叩くため rate limit と余計な edit が発生し、起動時限定に限るため却下。
- **tick scope を廃して startup のみ** — H1 はプロセス生存中も claim→send→crash 不完全時に起こり得るため tick scope を残す、却下。
- **`CANCELLED` の promotion を `settleAskingSession` へ寄せる** — settle は `ASKING → CANCELLED` が起点で CANCELLED 入力を扱わず、reconciler 側で持つのが責務上明瞭なため却下。

## 参照

- `docs/adr/0001-single-instance-db-as-source-of-truth.md`
- `docs/adr/0003-postgres-drizzle-operations.md`
- `docs/adr/0018-port-wiring-and-factory-injection.md`
- `docs/adr/0024-reminder-dispatch.md` (Consequences を本 ADR 採択に合わせて更新)
- 実装値の SSoT: `src/config.ts` (`REMINDER_CLAIM_STALENESS_MS`, `ASK_DEADLINE_HHMM`, `POSTPONE_DEADLINE_HHMM`)
