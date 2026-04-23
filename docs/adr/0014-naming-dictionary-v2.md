---
adr: 0014
title: 命名辞書 v2（ADR-0010 の運用強化）
status: accepted
date: 2026-04-23
supersedes: []
superseded-by: null
tags: [docs, runtime]
---

# ADR-0014: 命名辞書 v2（ADR-0010 の運用強化）

## TL;DR
ADR-0010 の動詞辞書を実装と一致させるための運用強化: `build*` は pure 限定、`refresh*` / `set*Id` は辞書外として廃止、文字列型の日付には `*Iso` サフィックスを義務化、dead export（`nextFriday18JST`）は削除する。

## Context
ADR-0010 で動詞辞書（`build*` = pure / `send*` = 副作用 / `find*` = DB read / `handle*` = 入口 / `transition*` = CAS / `settle*` = 締切後収束 ほか）を定めたが、実コードに辞書外 export が残存し「grep 可読性」「動詞で副作用種別を判別できる」効能が損なわれている。

- `buildAskRenderFromDb`: 名前は `build*`（pure のはず）だが async + DB I/O。辞書違反。
- `refreshAskMessage`: 辞書外動詞 `refresh*`。副作用種別（DB 再読込 / Discord 送信）が名前から読めない。
- `setAskMessageId` / `setPostponeMessageId`: `set*` prefix は辞書外で、repository の private mutation が public 露出。
- `candidateDate`（string 型）: SSoT 語彙は `candidateDateIso`。型と語彙が乖離し AI の取り違え事故源。
- `nextFriday18JST`: dead export。現 cron は `src/config.ts` の `CRON_ASK_SCHEDULE` 参照で、命名に含まれる「18」と食い違う。

ADR-0010 の骨格は有効で、必要なのは supersede ではなく運用強制力の追補。

## Decision
ADR-0010 を supersede せず、以下の運用強化を追加する。

### 動詞辞書の強制
- **`build*` は pure 限定**。DB I/O を伴うものは `find*`（read）、副作用は `send*` / `update*` / `create*` へリネーム。`buildAskRenderFromDb` は `findAskRender` 系へ分離。
- **`refresh*` 禁止**: 副作用種別（再取得 / 再送信）が読めない。`update*` / `send*` に分解。
- **`set*Id` は repository 内 private に降格**。public API は `createAskSession` / `transitionStatus` の返り値で吸収し、message ID 後書きは状態遷移の一部として扱う。

### 型と語彙の整合
- **文字列型日付に `*Iso` サフィックス義務化**: `candidateDate: string` → `candidateDateIso: string`。`Date` オブジェクトには suffix を付けない。migration 1 本（列 rename）。

### Dead code
- **`nextFriday18JST` 削除**。現 cron は `src/config.ts` の `CRON_ASK_SCHEDULE` 参照で命名と食い違う。復活時に命名規約を再評価する。

## Consequences

### Follow-up obligations
- 既存 public API 名が数件変わる。callers を同時更新して吸収する（外部依存なし）。
- migration 1 本（`candidateDate` → `candidateDateIso` 列 rename）を追加する。
- `nextFriday18JST` を削除する。復活時は命名規約を再評価してから復帰させる。
- 既存コードの `*Iso` サフィックスはこの migration でまとめて改名、新規コードは最初から強制。

### Operational invariants & footguns
- **`build*` は pure 限定**: DB I/O / 副作用を入れたら `find*` / `send*` / `update*` / `create*` へリネーム（辞書違反）。
- **`refresh*` / `set*Id` 公開禁止**: 副作用種別が読めない、repository private mutation は public 露出させない。
- 文字列型日付は `*Iso` 義務、`Date` オブジェクトには suffix を付けない（型と語彙の乖離が AI の取り違え事故源）。

## Alternatives considered

- **A: 辞書に `refresh*` / `set*` を追加** — `refresh` は「再取得」「再送信」の両義で副作用種別が読めず、`set` は書込み方向を示さず ADR-0010 の grep 可読性を損なう。
- **B: 現状維持（辞書違反を許容）** — AI エージェントが read-path で副作用有無を即判別するための根幹ルールで、緩めるとコメント量が増加方向に戻る。
- **C: ADR-0010 を supersede して全面再定義** — 動詞辞書の骨格は有効、破綻しているのは運用強制力のみ。supersede ではなく運用強化で足りる。
