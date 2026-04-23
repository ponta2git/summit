---
adr: 0032
title: /status コマンドによる運用観測性の追加
status: accepted
date: 2026-04-27
supersedes: []
superseded-by: null
tags: [discord, runtime, ops]
---

# ADR-0032: /status コマンドによる運用観測性の追加

## TL;DR
運用観測のため `/status` slash command を `src/features/status-command/` に実装する。ephemeral / guild-scoped / `MEMBER_USER_IDS` 限定。現在時刻・weekKey・非終端 Session の状態・回答数・HeldEvent 存否・次イベント予定・stranded invariant 警告（締切超過 ASKING / `askMessageId=NULL` / stale reminder claim）をコードブロックで返す read-only コマンド。C1/N1/H1 runbook の入口。

## Context

- `requirements/base.md` §3.6 が要求する `/status` コマンドが未実装（2026-04-21 review §3 M12）。
- C1（CANCELLED 宙づり）/ N1（ask publication gap）/ H1（stale reminder claim）の runbook はオペレーターが現在のセッション状態を目視確認できる前提だが、観測手段が存在しない。
- Discord 投稿からの類推は不完全で、特に `askMessageId=NULL`（DB には存在するが Discord 未投稿）は目視不可能。

## Decision

### Registration / Access

- `@see src/features/status-command/`。Guild-scoped bulk overwrite（global 禁止: ADR-0004）。
- 実行者: `env.MEMBER_USER_IDS` のみ。channel: `env.DISCORD_CHANNEL_ID` のみ。

### Handler flow

1. `deferReply({ ephemeral: true })`
2. DB 複数 read（`findNonTerminalSessions` + 並列 `listResponses` + `findBySessionId`）
3. `editReply(text)` — コードブロック形式（Embed の layout 複雑性を避ける）
4. **read-only**: DB 書き込み一切なし

### Output 内容

- 現在の JST 時刻と weekKey
- 非終端セッションごとの状態 / 回答数 / `MEMBER_COUNT_EXPECTED`
- DECIDED セッションの HeldEvent 存否（stale claim 検知）
- 次イベント（deadline / reminder）の最速時刻
- **stranded invariant 警告**: 締切超過の ASKING、`askMessageId=NULL`、stale reminder claim 等

### Layering

純粋ロジック（`viewModel.ts` / `invariantChecks.ts`）は AppContext 非依存。handler のみがポート呼び出しを担う（ADR-0018）。

## Consequences

### Operational invariants & footguns
- 実装は `findNonTerminalSessions()` + sessions 数分の `listResponses()` + `findBySessionId()` を並列発行する。4 名固定・週次運用では N+1 の実害ゼロ（M10 の既知許容と同じ論拠）だが、対象範囲が広がった場合は startup reconciler (ADR-0033) 側の aggregation に載せ替える。
- **read-only 契約を維持する**: `/status` は DB 書き込みを一切行わない。実状態の収束は reconciler / outbox worker に委ねる（`/status` の副作用で runbook が壊れないため）。

## Alternatives considered

- **Embed (EmbedBuilder) 形式** — フィールド最大 25 の制限とボイラープレートが 1 コマンドのテキスト出力に見合わないため却下。
- **ページネーション** — 非終端セッションは最大 2 件（金 + 土）で不要のため却下。
- **管理者専用チャンネル** — 運用チャンネル（`DISCORD_CHANNEL_ID`）と同一の方が既存 guard を再利用でき複雑性が増さないため却下。
