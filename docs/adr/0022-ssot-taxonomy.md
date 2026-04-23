---
adr: 0022
title: SSoT taxonomy（ADR / コード / コメント の役割分担と drift 防止）
status: accepted
date: 2026-04-24
supersedes: []
superseded-by: null
tags: [docs, runtime, ops]
---

# ADR-0022: SSoT taxonomy（ADR / コード / コメント の役割分担と drift 防止）

## TL;DR
情報種別ごとに SSoT を一意に割り当て（リテラル定数 → `src/config.ts` / `src/env.ts`、状態 → TS 型、DB 制約 → `src/db/schema.ts`、業務語彙 → `requirements/base.md`、設計判断の WHY → ADR）、他 artifact は pointer のみを持つ。ADR 本文・src コメントに実行時リテラル値（cron 式・HH:MM 等）を書かない。`@see ADR-NNNN` はタイトル断片を含めず番号か path のみ。

## Context
ADR と src コメントと `requirements/base.md` が情報を部分的に重複保持し、drift 源になっている（リテラルは論点そのもののため保持）:

- `src/scheduler/index.ts:189`: `// invariant: ADR-0007 により暫定で金 08:00 JST を維持する` — 「金 08:00 JST」がコード定数・ADR・コメントの 3 箇所に存在。
- `src/config.ts:6`: `// invariant: cron 送信時刻は ADR-0007 に基づき金曜 08:00 JST を維持する` — 同じリテラルの再記述。
- ADR-0007 本文に cron 式 `0 8 * * 5` が直接書かれ、`CRON_ASK_SCHEDULE` 定数と二重管理。

ADR-0010 は「SSoT を再記述しない」を原則化しているが、**どこに何を置くかの taxonomy が未明文化**で、(a) ADR-0007 の値変更でコメントが静かに陳腐化、(b) ADR タイトル rename で `@see ADR-XXXX タイトル断片` が腐る、(c) supersede 後も参照が残る、というリスクが実在する。drift 防止の規律を文書化する必要がある。

## Decision
**情報種別ごとに SSoT を一意に割り当て、他 artifact は pointer のみを持つ**。ADR-0010 原則 3（SSoT を再記述しない）の具体化。

### 情報種別 → SSoT マトリクス

| 情報種別 | SSoT | ADR の役割 | コメントの役割 |
|---|---|---|---|
| リテラル定数（cron 式・HH:MM・閾値・タイムアウト） | `src/config.ts` / `src/env.ts` | 「この値をコードで管理する」と宣言のみ。値自体を書かない | `// why: 根拠 → ADR-NNNN`（値を繰り返さない）|
| 型・状態遷移・discriminated union | TS 型定義 | 状態名の列挙は禁止（union がコンパイラに narrow される） | 型を読めば自明。コメント不要 |
| DB 制約 / schema | `src/db/schema.ts` | 「一意性の意図」を書く。列名/型は書かない | 制約の invariant 名で参照 |
| 業務ルールの振る舞い | `tests/domain/**` | 判定基準の WHY を書く | test 名で意味を語る |
| 用語・業務語彙 | `requirements/base.md` | ADR は業務語彙を引用するが再定義しない | 語彙を勝手に改変しない |
| 設計判断の WHY / 代替案の却下理由 | **ADR** | 本来の役割。実行不能情報の唯一の保管場所 | `// why: ADR-NNNN` ラベルのみ |
| 過渡期の妥協・暫定方針 | **ADR**（`status: accepted` + 移行条件） | 「なぜ今この形か」を書く | `// hack: ADR-NNNN` で目印 |
| 運用ポリシー（deploy 禁止窓・秘匿値扱い） | **ADR + AGENTS.md** | 人間行動の規範。コードに落ちない | 該当なし |

### 書き方規律

1. **コメントは pointer のみ**:
   - Good: `// why: 暫定 cron schedule → ADR-0007`
   - Bad: `// why: ADR-0007 により暫定で金 08:00 JST を維持する。`（値が drift 源）

2. **ADR 本文もリテラル値を書かない**:
   - Good（Decision 節）: 「自動送信スケジュールを `src/config.ts` の `CRON_ASK_SCHEDULE` に集約する」
   - Bad（Decision 節）: cron 式や HH:MM を直書き
   - 例外: **Context / Alternatives considered 節**は歴史的経緯・却下候補の記述として過去値を許容（ADR は append-only journal）。
   - 例外: ADR-0007 のような「暫定性そのもの」が決定内容の ADR では、暫定値の文章中 1 度限りの言及を許容。ただし「現在値は `src/config.ts` を参照」と明記。

3. **`@see` にタイトル文字列を埋めない**:
   - Good: `@see docs/adr/0001-single-instance-db-as-source-of-truth.md` / `@see ADR-0001`
   - Avoid: `@see ADR-0001 single-instance-db-as-source-of-truth`（rename で腐る）

4. **supersede の扱い**:
   - supersede したら当該 ADR 番号を src から grep し差し替えまたは削除。
   - 将来的に `pnpm verify:forbidden` へ「参照先 ADR の status 検証」を追加（本 ADR では規約のみ）。

### 適用範囲
- 本 ADR は ADR-0010 を補強。新規 ADR / 新規コメント / 既存コード修正時の指針。
- 採択時点の既存違反（ADR-0007 内リテラル等）は pointer 化して修正、以降の新規決定に適用。

## Consequences

### Follow-up obligations
- **既存違反の一括修正が必要**: 本 ADR 採択時点で検出された既存違反（ADR-0007 内リテラル、src コメント内リテラル）は修正する。

### Operational invariants & footguns
- **drift 源の明確化**: コメント / ADR にリテラルを書いた瞬間に drift 源と認識できる。レビューで機械的に指摘可能。
- **supersede 時の影響範囲が限定**: pointer しか持たないため、ADR 番号の grep → 差し替えで済む。値の追従は不要。
- **AI エージェント可読性**: 「この値の真実はどこ？」の問いに、taxonomy が答える。推測で drift を作り込むリスクが減る。
- **ADR の独立性**: ADR 本文から実行時リテラルが消えることで、コード変更に引きずられて ADR が更新対象になる頻度が下がる。
- **ADR の自己完結性が若干下がる**: 「この cron 式は何？」を知るには ADR → コード定数へ 1 ホップ必要。ただしコード定数名は ADR 本文に書かれるため辿りやすさは保たれる。
- **レビュー負荷**: 新規コメント / ADR 追加時に「値を書いていないか」を確認する工程が増える。機械検出は本 ADR では扱わない。

## Alternatives considered
- **現状維持（ADR-0010 原則 3 のみ）** — 一般規則だけでは「リテラル値を書かない」判断が各人に委ねられ drift が発生、本 ADR で taxonomy を明示する方が実効性が高い。
- **コード側にも ADR 番号を禁止** — コードから ADR に辿る grep 経路が断たれ AI エージェントの参照性が落ちるため却下。
- **リテラル検出 lint の同時導入** — 効果はあるが YAGNI を優先し、痛みが顕在化した時点で別 ADR で判断。
- **ADR を全面的にコード近傍（JSDoc）へ移す** — 長文 rationale や代替案理由が TSDoc に収まらず、ファイルをまたぐ判断の表現にも不向き。却下。
