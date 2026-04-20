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

## Context
ADR-0010 で動詞辞書（`build*` = pure、`send*` = 副作用、`find*` = DB read、`handle*` = 入口、`transition*` = CAS、`settle*` = 締切後収束 ほか）を定めたが、実コードには辞書外の export が残存している。

- `buildAskRenderFromDb`: 名前は `build*`（pure のはず）だが async + DB I/O を伴う。辞書違反。
- `refreshAskMessage`: 辞書にない動詞 `refresh*`。副作用の種類（DB 再読込 / Discord 送信）が名前から読めない。
- `setAskMessageId` / `setPostponeMessageId`: `set*` prefix は辞書外で、repository の private mutation に該当するものが public に露出している。
- `candidateDate`（string 型）: `requirements/base.md` の SSoT 語彙は `candidateDateIso`。型と語彙が乖離。
- `nextFriday18JST`: dead export。現 cron は `src/config.ts` の `CRON_ASK_SCHEDULE` を参照しており、命名に含まれる「18」が現状と食い違う。

これらは ADR-0010 が狙った「grep 可読性」「動詞で副作用の種類が判別できる」効能を損なう。ADR-0010 をそのまま残しつつ、運用ルールを強化する ADR が必要。

## Decision
ADR-0010 を supersede しない範囲で、以下の運用強化を追加する。

- **`build*` は pure 限定**。DB I/O を伴うものは `find*`（read）、副作用を伴うものは `send*` / `update*` / `create*` にリネームする。`buildAskRenderFromDb` は `findAskRender` 系へ分離する。
- **`set*Id` は repository 内 private に降格**する。public API は `createAskSession` / `transitionStatus` の返り値や拡張で吸収する。message ID の後書きは状態遷移の一部として扱う。
- **`refresh*` は `update*` / `send*` にリネーム**する。`refreshAskMessage` が Discord 送信を伴うなら `sendAskMessage`、DB 再読込のみなら `findAskRender` + 呼び出し側で `update*`。
- **文字列型の日付には `*Iso` サフィックスを義務化**する。`candidateDate: string` → `candidateDateIso: string`。`Date` オブジェクトには suffix を付けない。
- **dead export は削除**する。`nextFriday18JST` は現 cron と不整合で存在自体が誤解を生む。復活が必要になった時点で命名規約を再評価する。

migration を 1 本切る（`candidateDate` → `candidateDateIso` 列 rename）。

## Consequences

### 得られるもの
- ADR-0010 の動詞辞書が実装と一致し、grep 可読性が回復する（`rg "^export.*build"` が pure のみを返す）。
- 型と語彙（SSoT: `requirements/base.md`）が揃い、AI が日付文字列と Date オブジェクトを取り違える事故が減る。
- dead code の削除により、過去の運用（18 時 cron）と現状（08 時 cron）の認知ズレが消える。

### 失うもの / 制約
- 既存 public API 名が数件変わる。内部からのみ呼ばれているため、callers を同時更新すれば吸収できる。外部依存は無い（個人開発 Bot）。
- migration 1 本追加。

### 運用上の含意
- 新規関数を追加するレビューでは、辞書違反の疑いがある命名を指摘する。
- dead export は検知したら ADR-0010 + 本 ADR を根拠に削除する。復活時に命名を再設計する。
- `*Iso` サフィックスは新規コードで強制、既存は本 migration でまとめて改名。

## Alternatives considered

### 代替案 A: 辞書に `refresh*` / `set*` を追加する
却下。`refresh` は「再取得」と「再送信」の両方を指しうる曖昧語で、副作用の種類が名前から読めなくなる。`set` は mutation の方向（どこへ書き込むか）を示さない。ADR-0010 が狙った grep 可読性を損なう。

### 代替案 B: 現状維持（辞書違反を許容）
却下。ADR-0010 は AI エージェントが read-path で副作用の有無を即判別するための根幹ルール。緩めると「名前で伝わる範囲」が縮小し、コメント量が増える方向に戻る。

### 代替案 C: ADR-0010 を supersede して全面再定義
却下。動詞辞書の骨格は有効で、破綻しているのは運用強制力のみ。supersede ではなく運用強化で足りる。
