---
adr: "0032"
title: /status コマンドによる運用観測性の追加
status: accepted
date: 2026-04-27
supersedes: []
superseded-by: null
tags: [discord, runtime, ops]
---

# ADR-0032: /status コマンドによる運用観測性の追加

## Context

レビュー (2026-04-21 final-report §3 M12) で、`/status` コマンドが仕様 (`requirements/base.md §3.6`)
で要求されているにも関わらず未実装であることが指摘された。

C1 (CANCELLED 宙づり)・N1 (ask publication gap)・H1 (stale reminder claim) の復旧手順 (runbook) は
オペレーターが現在のセッション状態を目視確認できることを前提とするが、観測手段が存在しなかった。
Discord チャンネルの投稿メッセージから状態を類推する方法は不完全であり、
DB レコードに存在するが Discord に未投稿のセッション (askMessageId=NULL) は目視不可能だった。

## Decision

- `src/features/status-command/` 以下に `/status` slash command を実装する。
- Guild-scoped bulk overwrite で登録 (global 禁止: ADR-0004 準拠)。
- 実行者は `env.MEMBER_USER_IDS` に含まれるメンバーのみ（`env.DISCORD_CHANNEL_ID` 限定）。
- `deferReply({ ephemeral: true })` → DB 複数 read → `editReply(text)` の順で応答する。
- 返す情報:
  - 現在の JST 時刻と weekKey
  - 非終端セッション (`findNonTerminalSessions`) ごとの状態スナップショット
  - セッションごとの回答数 / `MEMBER_COUNT_EXPECTED`
  - DECIDED セッションの HeldEvent 存否（stale claim 検知に使用）
  - 次のイベント予定 (deadline / reminder) の最速時刻
  - stranded invariant 警告（締切超過の ASKING、askMessageId=NULL、stale reminder claim 等）
- コード block 形式でテキスト表示する（EmbedBuilder の layout 複雑性を避ける）。
- 純粋ロジック (`viewModel.ts`, `invariantChecks.ts`) は AppContext 非依存、handler がポート呼び出しを担う。

## Consequences

**得られるもの**:
- C1/N1/H1 の手動復旧 runbook の実行可能性（状態確認の起点）。
- stranded CANCELLED / NULL askMessageId / stale reminder claim を Discord 上で即座に発見できる。
- startup reconciler (P0 別 todo) 実装時の動作検証コマンドとして機能する。

**失うもの / 制約**:
- 返す情報量が多い場合にコードブロックが長くなる可能性があるが、4 名固定・週次運用では現実的に問題ない。
- `findNonTerminalSessions()` + sessions 数分の `listResponses()` + `findBySessionId()` を並列発行する。
  現規模では N+1 の実害ゼロ (M10 の既知許容と同じ論拠)。
- DB 書き込みは一切行わないため、このコマンド自体による状態変化はない (read-only)。

## Alternatives considered

- **Embed (EmbedBuilder) 形式**: フィールド最大数 25 の制限とフィールド組み立てのボイラープレートが多い。
  1コマンドのテキスト出力のコストに見合わないため却下。
- **ページネーション**: 非終端セッションは最大 2 件 (金 + 土) であり不要。
- **管理者専用チャンネル**: 運用チャンネルと同一 (`DISCORD_CHANNEL_ID`) の方が既存 guard を再利用でき
  複雑性が増さないため却下。
