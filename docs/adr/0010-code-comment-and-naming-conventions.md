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

## Context
summit は個人開発の Discord Bot で、AI エージェント（Codex / Claude Code / Copilot Coding Agent）が日常的にコードを読み書きする前提で運用する。既存コードベースには次の問題があった。

- 非自明な invariant（race / 冪等 / CAS / 単一インスタンス / JST / 年跨ぎ / Neon pooler / custom_id 契約）がコード近傍にコメント化されていない。読解のたびに AGENTS.md や ADR を横断する必要がある。
- 既存 TSDoc の一部が WHAT の列挙（実装を読めば自明な情報）で埋まっており、トークンを消費する割に判断材料にならない。
- 責務と名前のズレがある（例: `findActiveSessionByWeekKey` は active 絞り込みをしない、`candidateDateForSend` は恒等関数で意図が読み取れない）。
- grep で探せる共通プレフィックス（`invariant:` / `race:` 等）が無く、検索性が低い。

一方で、過剰なコメントや冗長な TSDoc は AI の読解時トークンを増やし、SSoT（`requirements/base.md` / 他 ADR / `.github/instructions/*.md`）と二重管理になる。最小十分で、かつ検索性が高く、かつリネームで置換可能な情報はコメントにしないルールが必要。

## Decision
コメントとネーミングの規約を `.github/instructions/comments.instructions.md` に新設し、`{src,tests}/**/*.ts` に適用する。原則は以下。

1. **ネーミング最優先**。名前で伝わるならコメントを書かない。伝わらないならまずリネームする。
2. **WHY のみ書く**。コードから自明な WHAT / HOW は書かない。非自明な invariant・race・仕様根拠・過渡期の妥協だけを書く。
3. **SSoT を再記述しない**。業務仕様・設計判断は ADR / requirements / 他 instructions にある。コード近傍では `@see ADR-NNNN` のようなラベルで済ませる。
4. **言語の使い分け**:
   - 業務仕様・運用上の背景・race / 冪等の説明 = 日本語。
   - 技術的 TSDoc（`@param` / `@returns` / `@throws` / 型の契約）= 英語。
   - `@remarks` では業務制約を日本語で書いて良い（英日ブリッジ）。
5. **grep 可能な小文字プレフィックス語彙**を整備する。新規コメントはこの語彙から始める。
   - 主要: `// invariant:` / `// race:` / `// idempotent:` / `// jst:` / `// iso-week:` / `// state:` / `// source-of-truth:` / `// ack:` / `// unique:` / `// tx:` / `// single-instance:` / `// deploy-window:` / `// redact:` / `// secret:` / `// hack:` / `// todo(ai):` / `// regression:` / `// why:`。
6. **TSDoc は境界越え export + 非自明 invariant に限定する**。内部 helper、thin wrapper、1 ファイル内利用の private 関数には付けない。
7. **動詞辞書でネーミングを固定する**: `build*` = pure / `send*` = 副作用 / `find*` = DB read 0..N / `try*` = 条件付き成功 / `handle*` = 入口 / `run*Tick` = cron 駆動 / `transition*` = CAS 状態遷移 / `settle*` = 締切後収束。違反したらリネームする。
8. **業務語彙（`weekKey` / `postponeCount` / `decidedStartAt` / 状態名 / `custom_id` フォーマット等）はリネーム禁止**。`requirements/base.md` の SSoT 語彙として不変。
9. **module preamble は原則書かない**。orchestration 責務のファイル（scheduler / interactions）のみ 2〜4 行で俯瞰。目次・責務一覧は書かない。
10. **テストは `describe` / `it` 名で仕様を語る**。コメントは invariant が非自明なケースの補足のみ。業務 invariant の回帰テストには `// regression:` を付けて削除防止シグナルにする。

## Consequences

### 得られるもの
- コード近傍で race / 冪等 / 時刻 / 単一インスタンス / pooler などの invariant が読めるため、AI エージェントが ADR を横断せずに判断できる場面が増える。
- プレフィックス語彙により `rg "// race:"` や `rg "// hack:"` などで全体傾向を即座に把握できる。
- ネーミングの統一で「関数名で意味が伝わる」範囲が拡大し、コメント量自体が減る。
- SSoT の一元化が保たれ、仕様変更時の更新箇所が `requirements/base.md` と ADR に限定される。

### 失うもの / 制約
- 既存コメントの書き換えコストが発生する。過渡期は旧形式と新形式が混在する。
- プレフィックスを覚える必要がある。新規コントリビューターに対するオンボーディング負荷が増える（対策: `.github/instructions/comments.instructions.md` を参照すれば自己完結する構造にする）。
- 英語 TSDoc と日本語通常コメントの混在で、ファイル内の言語が切り替わる。`@remarks` で日本語を許容することで緩和。

### 運用上の含意
- 既存コードベースへの適用は段階的に PR 分割する（指針 + ADR / WHY コメント / TSDoc / リネーム / テスト）。
- 新規 PR のレビューでは、コメント・ネーミング観点のチェックリストを `.github/instructions/comments.instructions.md` 末尾のチェックリストとして参照する。
- `// hack:` を書く PR は必ず対応 ADR を新規作成または参照させる（過渡期の妥協を永続記録する ADR 作成プロトコルと連動）。

## Alternatives considered

### 代替案 A: コメントを最小化し、ネーミングと ADR リンクのみで表現する
- 採用しない理由: コード近傍に race / 冪等 / 3 秒制約などの invariant を書かないと、read-path で ADR まで辿らないと判断できない。AI のトークン消費は減るが、判断の正確性が下がる。

### 代替案 B: コメントはすべて日本語、TSDoc も日本語
- 採用しない理由: TSDoc は IDE / LSP / 型ツール経由で英語の慣用構文（`@param` / `@returns` / `@throws`）として機能する。業務文脈だけを日本語で書き、型の契約は英語に寄せることで、読解と tooling の両立を図る。

### 代替案 C: プレフィックス語彙を導入せず、自由記述
- 採用しない理由: grep 可能性が失われ、「全 race condition コメントを列挙したい」のような横断レビューができなくなる。語彙は 18 個に絞り、ファイル単位で覚えなくても横断検索で発見できることを優先する。

### 代替案 D: TSDoc を全 export に付ける
- 採用しない理由: thin wrapper / 自明な helper にも TSDoc を強制すると、WHAT 列挙コメントが量産されトークンを浪費する。境界越え export + 非自明 invariant に限定することで、TSDoc の情報密度を高く保つ。
