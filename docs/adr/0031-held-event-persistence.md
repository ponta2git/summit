---
adr: 0031
title: HeldEvent 永続化（実開催回の履歴化と DECIDED→COMPLETED の atomic 化）
status: accepted
date: 2026-04-27
supersedes: []
superseded-by: null
tags: [runtime, db, ops]
---

# ADR-0031: HeldEvent 永続化（実開催回の履歴化と DECIDED→COMPLETED の atomic 化）

## TL;DR
実開催回を `held_events`（`session_id` unique）+ `held_event_participants`（複合 PK）の 2 テーブルに正規化して永続化する。挿入は `DECIDED → COMPLETED` CAS と**同一 tx**で実行し（`completeDecidedSessionAsHeld`）、中止回（CANCELLED / SKIPPED）はこの経路を通らないため §8.4 を自動的に満たす。参加者は `env.MEMBER_USER_IDS` ではなく `responses` の時刻選択スナップショットから引く。

## Context

`requirements/base.md` §8.3 は**実際に開催された回**を HeldEvent（実開催日・開始時刻・紐づく Session・参加メンバー一覧）として永続化するよう定める。§8.4 は中止回（`CANCELLED` / `SKIPPED`）で HeldEvent を作らないと明記。将来の戦績集計システム（別ドメイン）が HeldEvent を入力とする前提。

現状の `DECIDED → COMPLETED` は `transitionStatus` の単純 CAS のみで履歴が DB に残らず、「いつ・誰で開催されたか」を Bot 再起動・運用レビュー時に確認する手段がない。

## Decision

### Schema

2 テーブル正規化。schema 詳細は `@see src/db/schema.ts`（`held_events` / `held_event_participants`）。
- `held_events.session_id` に **unique 制約**、挿入は `onConflictDoNothing` で冪等化。
- `held_event_participants` は複合 PK（`held_event_id` + `member_id`）で衝突 no-op。
- 配列列ではなく正規化: 将来の戦績列を ALTER で乗せやすくするため（ADR-0013 YAGNI で初版は最小列）。

### 記録タイミング（atomic）

- **専用 repository `completeDecidedSessionAsHeld` が `DECIDED → COMPLETED` CAS と `held_events` / `held_event_participants` INSERT を同一 tx で実行**。
- **invariant**: `COMPLETED` は終端で起動時リカバリ対象外。別 tx だと「`COMPLETED` だが HeldEvent 無し」が自然回復せず残るため、単一 tx 必須。
- リマインド送信後／送信不要条件成立後の経路のみこの repository を通る（ADR-0024）。中止回（`CANCELLED` / `SKIPPED`）はこの経路を通らず §8.4 を自動的に満たす。

### 参加者の出典

- **`responses` の時刻選択（T2200/T2230/T2300/T2330）スナップショット**を使う。`env.MEMBER_USER_IDS` 現行値は**使わない**（メンバー変更時に過去回が歪むため）。
- DECIDED 到達時点で全員 ABSENT は `decide.ts` が除外済み。

### Port / Migration

- `AppPorts.heldEvents`（`HeldEventsPort`）を追加。既存 `sessions.transitionStatus` からは直接遷移させず、リマインド完了経路のみ使用。
- `drizzle/0004_*.sql` として migration 追加。FK: `session_id`→sessions / `held_event_id`→held_events は CASCADE、`member_id`→members は no-action。
- `scripts/dev/reset.ts` の TRUNCATE 列挙に `held_event_participants, held_events` を追加（CASCADE に依存せず可読性重視）。

## Consequences

### Follow-up obligations
- §8.3 が要求するのは「実開催の事実」のみ。勝敗・得点列は別 PR / 別 ADR で扱う（本 ADR の schema を前提にしない）。
- `scripts/dev/reset.ts` の TRUNCATE 列挙に `held_event_participants, held_events` を追加する（`ON DELETE CASCADE` で伝播するが可読性担保のため明示）。

### Operational invariants & footguns
- **DECIDED→COMPLETED の CAS と HeldEvent 挿入は必ず同一 tx で commit する**。別 tx にすると「COMPLETED だが HeldEvent 無し」という自然回復経路の無い不整合が残る（`COMPLETED` は終端状態で `findNonTerminalSessions` の起動時リカバリ対象外）。
- FK cascade の方針: `held_events.session_id` / `held_event_participants.held_event_id` は CASCADE、`held_event_participants.member_id → members.id` は no-action（メンバー削除は独立運用）。dev reset / migration 修正時にこの非対称を崩さない。

## Alternatives considered

- **配列列 `participant_member_ids text[]`** — 戦績列追加時に member ごとの属性を持てず結局正規化が必要になるため却下。
- **記録を DECIDED 時に行う** — `/cancel_week` による `DECIDED → SKIPPED` で「実開催しなかったのに HeldEvent が残る」§8.4 違反となり、削除処理を別途設計する羽目になるため却下。
- **CAS と HeldEvent 挿入を別 tx に分離** — 片側成功時の不整合が終端状態のため自然回復せず、単一 tx 一択のため却下。
- **`env.MEMBER_USER_IDS` から参加者を引く** — env は実行時設定であり参加者スナップショットではなく、メンバー変更時に過去回履歴が歪むため却下。
