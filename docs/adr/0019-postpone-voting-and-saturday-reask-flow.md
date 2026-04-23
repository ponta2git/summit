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

## TL;DR
金曜 `ASKING` に欠席者が出たら `POSTPONE_VOTING` で順延可否を確認し、全員 OK なら `POSTPONED` 遷移と**同時に**土曜 `ASKING`（`postponeCount=1`）を生成・送信する（土曜 18:00 cron は使わない）。NG が 1 票でも出た / 締切時未回答があれば `CANCELLED`。再順延なし（`postponeCount` は 0/1 のみ）。

## Context
金曜 `ASKING` で欠席・未回答が出た場合の後続フローが要請 §6 とコード間で乖離。駆動 force:

- **取りこぼし回避 vs 意思尊重**: 即中止は「翌日ずらせば開催できた週」を取りこぼす／順延確認なしの自動土曜再募集はメンバー意思と乖離。順延意思を確認してから土曜へ進む中間状態が必要。
- **仕様記述と実装の衝突**: `requirements/base.md` は「土曜 18:00 再送」と記すが、実装は「金曜の順延投票成立直後に土曜募集を生成・送信」へ収束済み。どちらが正かを ADR で確定させないと参照元として機能しない。

## Decision

### State transitions（金曜 ASKING 終了以降）
1. **欠席 ≥1** → `POSTPONE_VOTING`。`sessions.deadlineAt` を `postponeDeadlineFor(candidateDate)` で上書きし、順延確認メッセージを投稿。
2. **全員 OK** → `POSTPONED`（終端）へ遷移し、**同一トランザクション内で**土曜 `ASKING`（`postponeCount=1`）を作成・送信。`weekKey` は金曜と共有、候補日は `saturdayCandidateFrom(金曜候補)`。
3. **NG ≥1** → `CANCELLED` / `cancelReason="postpone_ng"`。
4. **締切超過 かつ 未回答残** → `CANCELLED` / `cancelReason="postpone_unanswered"`。
5. **土曜 `ASKING` 締切時に未回答 or 欠席** → `CANCELLED` / `cancelReason="saturday_cancelled"`。

### Invariants
- **再順延なし**: `postponeCount` は `0` or `1` のみ。
- **土曜定時 cron は使わない**: 土曜 ASKING 生成は金曜 `POSTPONED` 成立と同時のみ。`requirements/base.md` の「土曜 18:00 再送」記述は本 ADR により置換。
- **週キー共有**: 金曜/土曜 Session は同一 `weekKey`。

### Implementation pointers
- 締切値・cron 式等の実値は `src/config.ts` / `src/time/` が SSoT（ADR-0022）。
- 起動時リカバリは**期限切れ `POSTPONE_VOTING` Session も対象**に含めて settle する。

## Consequences

### Follow-up obligations
- `postponeCount` を 2 以上へ拡張する場合、状態遷移・UI 文言・終端理由を含む再設計が必要。

### Operational invariants & footguns
- 要件 §6 の順延仕様を、順延意思確認から土曜再募集まで一貫して自動化できる。
- `transitionStatus` の CAS、`(sessionId, memberId)` unique、`(weekKey, postponeCount)` unique により、同時押下・cron 競合でも二重処理を吸収できる。
- 土曜募集の送信タイミングは「金曜 `POSTPONED` 成立直後」となるため、土曜日中の任意時刻に発火しうる。従来文言の「土曜 18:00 JST」とは一致しない。
- 順延投票の締切（土曜 00:00 JST）は、デプロイ禁止窓（金 17:30〜土 01:00 JST）の内部に位置するため、金曜夕方以降の変更投入は特に慎重な運用が必要。
- 単一インスタンス前提は維持し、cron は重複登録せず 1 系統で運用する。

## Alternatives considered
- **土曜 cron で `postponeCount=1` の `ASKING` を生成** — 送信を意図的に遅延させる利得が薄く、金曜投票成立時点で即時開始する方が簡潔。却下。
- **`POSTPONE_VOTING` 専用 deadline カラム / 別テーブル** — 既存 `sessions.deadlineAt` 上書きで schema 追加不要、運用複雑性を抑えるため却下。
- **`postponeCount` 無制限で再順延可能化** — 固定 4 名・1 年勝負では利得が小さく状態遷移が増えるだけ。却下。
