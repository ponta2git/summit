---
id: "0031"
title: "HeldEvent 永続化（実開催回の履歴化と DECIDED→COMPLETED の atomic 化）"
status: accepted
date: 2026-04-27
tags: [runtime, db, ops]
supersedes: []
superseded-by: []
---

# HeldEvent 永続化（実開催回の履歴化と DECIDED→COMPLETED の atomic 化）

## Context

`requirements/base.md` §8.3 は、**実際に開催された回**を HeldEvent（実開催日・開始時刻・紐づく Session・参加メンバー一覧）として永続化することを定める。§8.4 は中止回（`CANCELLED` / `SKIPPED`）では HeldEvent を作らないと明記する。将来の戦績集計システム（別ドメイン）が HeldEvent を入力とする前提。

これまでの実装では `DECIDED → COMPLETED` は `transitionStatus` の単純な CAS のみで、実開催の履歴が DB に残っていなかった。Bot 再起動や運用者レビュー時に「いつ・誰で開催されたか」を確認する手段が無い。

## Decision

1. **2 テーブル構成で永続化する**：`held_events`（id / session_id unique / held_date_iso / start_at / created_at）と `held_event_participants`（複合 PK: held_event_id + member_id）。

   - 配列列ではなく正規化した 2 テーブルにするのは、将来の戦績集計（勝者・得点などメンバーごとの属性）を ALTER で乗せやすくするため（ADR-0013 YAGNI に沿って初版は最小列）。

2. **記録タイミングは `DECIDED → COMPLETED` 遷移と同じ単一 DB transaction**。専用 repository `completeDecidedSessionAsHeld` を設け、`DECIDED` 条件付き `UPDATE`（CAS）と `held_events` / `held_event_participants` の INSERT を同一 tx で行う。

   - リマインド送信後／送信不要条件成立後にこの経路を通るため（ADR-0024）、中止回（CANCELLED / SKIPPED）は通らず §8.4 を自動的に満たす。

3. **参加メンバーの出典は `responses` の時刻選択（T2200/T2230/T2300/T2330）**。`env.MEMBER_USER_IDS` 現行値ではなく、その session における実際の応答をスナップショットする。DECIDED 到達時点で全員 ABSENT は `decide.ts` が除外済み。

4. **`held_events.session_id` に unique 制約**を置き、挿入は `onConflictDoNothing` で冪等にする。participants 側も複合 PK 衝突で no-op。

## Consequences

- **永続整合性**: `COMPLETED` は終端状態で、起動時リカバリ（`findNonTerminalSessions`）の対象外。CAS 成功と HeldEvent 挿入を別 tx で行うと「COMPLETED だが HeldEvent 無し」という自然回復の無い不整合が残る。単一 tx で `COMMIT` することで回避する。
- **Port 追加**: `AppPorts.heldEvents`（`HeldEventsPort`）が追加される。既存の `sessions.transitionStatus` から直接遷移させるのではなく、リマインド完了経路のみこの port を使う。
- **dev reset**: `scripts/dev/reset.ts` は sessions→held_events の `ON DELETE CASCADE` で伝播するが、可読性のため TRUNCATE 列挙に `held_event_participants, held_events` を追加する。
- **戦績列は未実装**: §8.3 は実開催の「事実」のみを要求する。勝敗・得点列は別 PR / 別 ADR で扱う。
- **migration**: `drizzle/0004_*.sql` として追加。`held_events.session_id → sessions.id` と `held_event_participants.held_event_id → held_events.id` は CASCADE、`held_event_participants.member_id → members.id` は no-action（メンバー削除は独立運用）。

## Alternatives considered

- **配列列 `participant_member_ids text[]`**: 初版は最小だが、戦績列を足す際に member ごとの属性を持てず結局正規化が必要になる。将来コストを先送りするだけ。
- **記録を DECIDED 時に行う**: `/cancel_week` による `DECIDED → SKIPPED` があり得るため、DECIDED 時記録だと「実開催しなかったのに HeldEvent が残る」リスク。§8.4 違反になり、削除処理を別途設計する羽目になる。COMPLETED 時記録でこの分岐を避ける。
- **CAS と HeldEvent 挿入を別 tx に分離**: 片側成功時の不整合が終端状態のため自然回復しない（前述）。単一 tx の一択。
- **`env.MEMBER_USER_IDS` から参加者を引く**: 現行環境変数は参加者スナップショットではなく実行時設定。将来メンバー変更が入った場合に過去回の履歴が歪む。
