---
adr: 0019
title: 順延投票と土曜再募集フローの確定（POSTPONE_VOTING / 即時 Saturday ASKING）
status: accepted
date: 2026-04-24
supersedes: []
superseded-by: null
tags: [runtime, discord, db, time, ops]
---

# ADR-0019: 順延投票と土曜再募集フローの確定（POSTPONE_VOTING / 即時 Saturday ASKING）

## Context
- 金曜の募集（`ASKING`）で欠席者や未回答者が出た場合、即週終了にすると「翌日にずらせば開催できる週」を取りこぼす。
- 一方で、順延可否を確認せずに土曜募集へ自動移行すると、メンバーの意思と乖離した再募集になる。
- そのため、金曜中止時はまず順延意思を `POSTPONE_VOTING` で確認し、**全員が OK の場合のみ**土曜募集へ差し替える必要がある。
- 既存仕様文には「土曜 18:00 再送」の記述があるが、実装は「金曜の順延投票成立直後に土曜募集を生成・送信」へ収束しており、仕様根拠を ADR として確定する必要がある。

## Decision
1. 金曜 `ASKING` 終了時に欠席が 1 名以上ある場合は `POSTPONE_VOTING` へ遷移する。  
   `sessions.deadlineAt` は `postponeDeadlineFor(candidateDate)`（候補日翌日 00:00 JST）に上書きし、順延確認メッセージを投稿する。
2. `POSTPONE_VOTING` で 4 名全員が `POSTPONE_OK` の場合は `POSTPONED`（終端）に遷移し、**同時に**土曜 `ASKING`（`postponeCount=1`）を作成・送信する。  
   `weekKey` は金曜回と同一、候補日は `saturdayCandidateFrom(金曜候補)` を使う。  
   土曜募集の生成に土曜定時 cron は使わない。`requirements/base.md` の「土曜 18:00 再送」記述は本 ADR により置き換える。
3. `POSTPONE_VOTING` 中に 1 名でも `POSTPONE_NG` を選んだ場合は `CANCELLED`（`cancelReason="postpone_ng"`）で終端化する。
4. `POSTPONE_VOTING` の締切（候補日翌日 00:00 JST）超過時に未回答者が残る場合は `CANCELLED`（`cancelReason="postpone_unanswered"`）で終端化する。
5. 土曜 `ASKING`（`postponeCount=1`）は金曜回と同様に判定するが、締切時に未回答または欠席があれば `CANCELLED`（`cancelReason="saturday_cancelled"`）で終端化する。再順延は行わない（`postponeCount` は 0/1 のみ）。
6. 順延投票締切判定の cron を `src/config.ts` の `CRON_POSTPONE_DEADLINE_SCHEDULE`（JST 土曜 00:00、`POSTPONE_DEADLINE="24:00"` に対応）として採用する。
7. 起動時リカバリでは、期限切れ `POSTPONE_VOTING` Session も対象に含めて settle する。

## Consequences
- Positive
  - 要件 §6 の順延仕様を、順延意思確認から土曜再募集まで一貫して自動化できる。
  - `transitionStatus` の CAS、`(sessionId, memberId)` unique、`(weekKey, postponeCount)` unique により、同時押下・cron 競合でも二重処理を吸収できる。
- Negative / trade-offs
  - `postponeCount` を 2 以上へ拡張する場合、状態遷移・UI 文言・終端理由を含む再設計が必要。
  - 土曜募集の送信タイミングは「金曜 `POSTPONED` 成立直後」となるため、土曜日中の任意時刻に発火しうる。従来文言の「土曜 18:00 JST」とは一致しない。
- Operational implications
  - 順延投票の締切（土曜 00:00 JST）は、デプロイ禁止窓（金 17:30〜土 01:00 JST）の内部に位置するため、金曜夕方以降の変更投入は特に慎重な運用が必要。
  - 単一インスタンス前提は維持し、cron は重複登録せず 1 系統で運用する。

## Alternatives considered
- **土曜 cron で `postponeCount=1` の `ASKING` を生成する案**
  - `requirements/base.md` 原文に近いが、金曜投票完了から送信まで意図的に遅延させる運用上のメリットが薄い。Friday 投票成立時点で即時に土曜回を開始できる設計を採用する。
- **`POSTPONE_VOTING` 専用の別 deadline カラム / 別テーブルを持つ案**
  - 状態別 deadline を既存 `sessions.deadlineAt` へ上書きする方が schema 追加なしで簡潔。実装と運用の複雑性を抑えるため不採用。
- **`postponeCount` を無制限にして再順延可能にする案**
  - 固定 4 名・1 年勝負の現仕様では利得が小さい一方、状態遷移と終端条件が増えて運用負荷が上がるため却下。
