---
adr: 0010
title: コメント / ネーミング規約（AI フレンドリーな最小十分コメント）
status: accepted
date: 2026-04-22
supersedes: []
superseded-by: null
tags: [docs, runtime, ops]
---

# ADR-0010: コメント / ネーミング規約（AI フレンドリーな最小十分コメント）

## TL;DR
コメントは WHY のみ、grep 可能な小文字プレフィックス語彙（`// invariant:` / `// race:` / `// jst:` / `// hack:` 等）から始める。TSDoc は境界越え export と非自明 invariant に限定。動詞辞書（`build*` / `send*` / `find*` / `handle*` / `transition*` / `settle*` 等）で関数名の意味を固定する。

## Context
AI エージェント（Codex / Claude Code / Copilot Coding Agent）が日常的にコードを読み書きする前提で、コメント / ネーミング規約を定める。既存コードベースには次の力学が併存する。

- 非自明な invariant（race / 冪等 / CAS / 単一インスタンス / JST / 年跨ぎ / Neon pooler / custom_id 契約）が近傍コメント化されておらず、読解のたびに AGENTS.md / ADR 横断が必要。
- 一方で WHAT 列挙の冗長 TSDoc は AI の読解トークンを圧迫し、SSoT（`requirements/base.md` / 他 ADR / `.github/instructions/*.md`）との二重管理になる。
- 責務と名前のズレがある（例: `findActiveSessionByWeekKey` が active 絞り込みをしない、`candidateDateForSend` が恒等関数）— 名前で副作用 / 純粋性が判別できない。
- grep 可能な共通プレフィックス（`invariant:` / `race:` 等）が無く、横断レビュー（全 race condition 列挙など）が困難。

これらは「最小十分・検索性が高い・リネーム可能な情報はコメントにしない」という緊張関係を解く必要がある。

## Decision
規約本体は `.github/instructions/comments.instructions.md`（適用 `{src,tests}/**/*.ts`）。

### 原則
1. **ネーミング最優先**。名前で伝わるならコメント不要、伝わらなければリネーム。
2. **WHY のみ**。WHAT / HOW は書かない。invariant / race / 仕様根拠 / 過渡期の妥協のみ。
3. **SSoT 再記述禁止**。コード近傍は `@see ADR-NNNN` ラベルに留める（ADR-0022）。

### 言語
- 業務説明・race / 冪等 = 日本語。
- TSDoc（`@param` / `@returns` / `@throws`）= 英語（IDE/LSP tooling 整合）。
- `@remarks` は日本語可（英日ブリッジ）。

### コメント形式
- **grep 可能な小文字プレフィックス語彙**から開始。語彙一覧は instructions ファイル参照。新規プレフィックスは instructions を更新してから使う。
- **TSDoc は境界越え export + 非自明 invariant に限定**。内部 helper / thin wrapper / ファイル内 private には付けない。
- **module preamble は原則書かない**。orchestration（scheduler / interactions）のみ 2〜4 行で俯瞰、目次・責務一覧は禁止。

### ネーミング
- **動詞辞書で副作用種別を固定**（`build*` / `send*` / `find*` / `try*` / `handle*` / `run*Tick` / `transition*` / `settle*` 等、定義は instructions）。違反はリネーム。
- **業務語彙リネーム禁止**: `requirements/base.md` の SSoT 語彙（`weekKey` / `postponeCount` / `decidedStartAt` / 状態名 / `custom_id` フォーマット 等）は不変。

### テスト
`describe` / `it` 名で仕様を語る。コメントは非自明 invariant のみ。業務 invariant の回帰テストには `// regression:` を付け削除防止シグナルとする。

## Consequences

### Follow-up obligations
- 既存コードベースへの適用は段階的に PR 分割する（指針 + ADR / WHY コメント / TSDoc / リネーム / テスト）。過渡期は旧形式と新形式が混在する。
- `// hack:` を書く PR は必ず対応 ADR を新規作成または参照させる（ADR 作成プロトコルと連動）。
- 新規プレフィックスは `.github/instructions/comments.instructions.md` を更新してから使用する（自由記述増殖で grep 可読性が劣化する footgun）。

### Operational invariants & footguns
- SSoT 再記述禁止: コード近傍に仕様値・ADR 本文を書き写さない（ADR-0022）。drift 源になる。
- TSDoc を全 export に広げない。thin wrapper / 自明 helper に付けると WHAT 列挙が量産され情報密度が落ちる。
- 業務語彙（`weekKey` / `postponeCount` / 状態名 / `custom_id` フォーマット 等）は `requirements/base.md` 固定で勝手にリネームしない。

## Alternatives considered

- **コメント最小化（ネーミング + ADR リンクのみ）** — invariant を近傍に残さないと read-path で ADR まで辿る必要があり判断精度が落ちる。
- **TSDoc も日本語** — TSDoc は IDE / LSP の英語慣用構文（`@param` / `@returns` / `@throws`）として機能させ tooling と両立させたい。
- **プレフィックス語彙なしの自由記述** — grep 可能性が失われ横断レビュー（例: 全 race condition 列挙）ができなくなる。
- **TSDoc を全 export に強制** — thin wrapper や自明 helper で WHAT 列挙が量産され情報密度が下がる。境界越え + 非自明 invariant に限定する。
