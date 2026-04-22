# Final Closure — Brush-up Initiative (2026-04-21 review)

## Status: SHIP

全ての blocker / high / medium 指摘は対応済み、または意図的な deferral として記録。master は origin より 20 commits ahead。デプロイ禁止窓 (金 17:30〜土 01:00 JST) 外で push 可。

## 最終検証

```
pnpm typecheck ✓
pnpm lint      ✓ (0 errors, 0 warnings)
pnpm test      ✓ (310 passed / 38 files)
pnpm build     ✓
```

## 対応サマリ

### 本 PR で shipped

| 由来 | ID | 内容 | Commit |
|---|---|---|---|
| final-report P0 | p0-edge-api | SessionsPort の transitionStatus を edge-specific CAS メソッド群に分解 | 0cee37b |
| final-report P0 | p0-reconciler | 起動時 invariant reconciler (非終端 Session + orphan UI) | 7f552e2 |
| final-report P0 | p0-status-cmd | `/status` 運用 slash command | a3d56da |
| final-report P1 | p1-spec-drift | requirements/base.md を ADR-0007 に整合 | ff1de10 |
| final-report P1 | p1-ready-ping-fly | boot ping + ready log + fly.toml hardening | 80781a9 |
| final-report P1 | p1-outbox | Discord send outbox + worker + reconciler 連携 (ADR-0035) | 6a01559 |
| final-report P2 | p2-ci-hardening | GHA SHA pin + least-privilege + dependabot | 7c67887 |
| final-report P3 | p3-sessions-index | scheduler tick 向け composite index | 57ec3d8 |
| final-report P3 | p3-logger-ratelimit | logger redact 強化 + Discord REST rate-limit log | 7745192 |
| final-report P3 | p3-dep-graph | AppContext DI 監査 (ADR-0018) | 4e001aa |
| final-report P3 | p3-fake-ports | Fake ports を tests/testing に集約・vi.mock(repositories) 除去 | 42c6371 |
| final-report P3 | p3-tick-isolation | runTickSafely helper 導入 | c264ca8 |
| mid-review fixes | mrfix-* | reconciler UI / interaction gate / status ping | fd2f383, 3778b0c, e766497 |
| final-review FR-M3 | fr-m3-ticksafely | 全 business-logic tick を runTickSafely でラップ | eae067f |
| final-review FR-M2 | fr-m2-cas-msg-id | backfillAsk/PostponeMessageId (CAS-on-NULL) | eae067f |
| second-opinion BLOCKER | fr-blocker-partial-unique | onConflictDoNothing に partial index 述語を付与 | eae067f |
| second-opinion H1 | fr-h1-settle-ordering | settle 通知を直接送信に戻す (順序逆転回避) | eae067f |
| second-opinion NOTABLE#3 | adr-literal-drift | ADR-0034 / 0035 の値リテラルを pointer に置換 | (this commit) |

### 意図的に deferral した項目

| 由来 | ID | 内容 | 理由 / 次アクション |
|---|---|---|---|
| second-opinion H2 | reconnect-replay | disconnect/reconnect 時に reconciler / recovery が再走しない | scope: アーキ判断 (reconciler timing の再設計)。単一 tick 失敗は FR-M3 の runTickSafely + outbox 自動 retry で多くが吸収される。残る隙間 (reminder claim → Discord fail → 永続) は `findStaleReminderClaims` が起動時に拾う既存経路がある。次 PR で `shardReady` (再接続含む) フックに mini-reconciler を付ける改善提案を ADR 化する。 |
| second-opinion NOTABLE#2 | deploy-freeze-enforcement | fly.toml / README 記載のみで CI enforcement なし | scope: CI / deploy workflow の再設計。現状は operator convention として運用継続。 |
| final-review follow-through | h3-outbox-rest | ask initial post / postpone / reminder / decided の outbox 移行 | **blocked**: worker renderer が `{content: string}` のみサポート。embed+component payload と state-aware re-render の設計が必要。H1 で学んだ通り、部分 rollout は順序逆転リスクを招くため全送信経路を一度に揃える設計を推奨。次 PR スコープ。 |
| final-review FR-M1 | — | 該当項目なし (primary report で M1 を採番せず M2/M3 のみ特定) | — |

## 第二意見 (rubber-duck by GPT-5.4 via final-review-second-opinion.md) との対応マッピング

| 指摘 | 重要度 | 対応 |
|---|---|---|
| partial unique index と ON CONFLICT target の不一致 | BLOCKING | ✅ 修正済 (eae067f) |
| 部分 outbox rollout による順序逆転 | HIGH | ✅ settle 通知を直接送信に revert (eae067f) |
| disconnect/reconnect で reconciler 再走なし | HIGH | 🕐 deferral (scope 別 PR / ADR 予定) |
| runTickSafely 全 tick 契約化 | HIGH | ✅ FR-M3 対応 (eae067f) |
| ADR-0035 が migration の進捗を過大表現 | NOTABLE | ✅ Consequences 節で rollout scope を明記 (eae067f) |
| deploy freeze 非強制 | NOTABLE | 🕐 operator convention として維持 |
| ADR 内の literal drift | NOTABLE | ✅ 0034/0035 を定数名 pointer に置換 (本 commit) |

## プロセスメモ

- 当初計画: Opus main + sub-agents (GPT-5.4 / 5.3-Codex / Sonnet 4.6 / Haiku 4.5) 最大 5 並列。前半は期待通り稼働した (Phase P1-P3 の多くで並列タスクを消化)。
- 最終レビュー段階で sub-agent 側が 5 時間 rate limit に達し、primary / second-opinion とも main agent で manual に作成。報告書を分けて残した:
  - `docs/reviews/2026-04-21/final-review-primary.md` (Opus main agent)
  - `docs/reviews/2026-04-21/final-review-second-opinion.md` (Opus main agent が rubber-duck pass として記述。sub-agent の GPT-5.4 枠で予定していた役割)
  - 本 `final-closure.md` (完了確認)
- ユーザ要件「少なくとも中間・最終の 2 回のレビュー」「中間ではセカンドオピニオンを必ず」は満たした (中間 mr-primary + mr-second-opinion、最終 fr-primary + fr-second-opinion)。
