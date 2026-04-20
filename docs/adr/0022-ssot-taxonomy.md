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

## Context
ADR と src コメントと `requirements/base.md` が**情報を部分的に重複保持**している箇所がある。

- `src/scheduler/index.ts:189`: `// invariant: ADR-0007 により暫定で金 08:00 JST を維持する` — 「金 08:00 JST」リテラルがコード定数・ADR・コメントの 3 箇所に存在。
- `src/config.ts:6`: `// invariant: cron 送信時刻は ADR-0007 に基づき金曜 08:00 JST を維持する` — 同じリテラルの再記述。
- ADR-0007 本文に cron 式 `0 8 * * 5` が直接書かれており、`CRON_ASK_SCHEDULE` 定数と二重管理。

ADR-0010（コメント規約）は「SSoT を再記述しない」を原則 3 に掲げているが、**「何が SSoT でどこに置くか」の taxonomy が明文化されていない**ため、実運用では (a) ADR-0007 の値変更でコメントが静かに陳腐化する、(b) ADR タイトル rename で `@see ADR-XXXX タイトル断片` が腐る、(c) supersede された ADR への参照が残存する、というリスクが実在する。

SSoT の所在を情報種別ごとに規定し、drift 防止の規律を文書化する必要がある。

## Decision
**情報種別ごとに SSoT を一意に割り当て、他の artifact は pointer のみを持つ**という原則を成文化する。

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
   - Bad: `// why: ADR-0007 により暫定で金 08:00 JST を維持する。`（値 "金 08:00 JST" が drift 源）

2. **ADR 本文もリテラル値を書かない**:
   - Good (Decision 節): 「自動送信スケジュールを `src/config.ts` の `CRON_ASK_SCHEDULE` に集約する」
   - Bad (Decision 節): 「cron 式は `0 8 * * 5`（timezone `Asia/Tokyo`）」
   - 例外: **Context / Alternatives considered 節**は歴史的経緯や却下した候補を書く場所なので、過去の値や却下された候補値を記述することは許容する（ADR は append-only の journal）。
   - 例外: ADR-0007 のような「暫定性そのもの」が決定内容の ADR では、暫定値を文章中で 1 度だけ言及することは許容。ただし「コード定数の現在値は `src/config.ts` を参照」と明記し、重複参照先を 1 箇所に絞る。

3. **ADR タイトル文字列を @see に埋め込まない**:
   - Good: `@see docs/adr/0001-single-instance-db-as-source-of-truth.md`（path は file rename が無い限り安定）
   - Good: `@see ADR-0001`（番号のみ、最小）
   - Avoid: `@see ADR-0001 single-instance-db-as-source-of-truth`（タイトル rename で腐る）

4. **supersede の扱い**:
   - ADR を supersede したら、当該 ADR 番号を src から参照している全箇所を grep し、ADR 番号差し替えまたは削除を行う。
   - `pnpm verify:forbidden` に将来的に「ADR 参照先の status 検証」を追加して CI で機械的に検出する（本 ADR では規約のみ規定し、lint 実装は別 ADR で扱う）。

### 適用範囲
- 本 ADR は ADR-0010（コメント規約）を補強する。旧 ADR の原則 3「SSoT を再記述しない」を具体化した形で、新規 ADR 作成時・新規コメント追加時・既存コード修正時の指針とする。
- 既存の違反（ADR-0007 本文内の cron 式リテラル等）は適用時点で洗い出し、pointer 化して修正する。以降の新規決定に適用する。

## Consequences
### 得られるもの
- **drift 源の明確化**: コメント / ADR にリテラルを書いた瞬間に drift 源と認識できる。レビューで機械的に指摘可能。
- **supersede 時の影響範囲が限定**: pointer しか持たないため、ADR 番号の grep → 差し替えで済む。値の追従は不要。
- **AI エージェント可読性**: 「この値の真実はどこ？」の問いに、taxonomy が答える。推測で drift を作り込むリスクが減る。
- **ADR の独立性**: ADR 本文から実行時リテラルが消えることで、コード変更に引きずられて ADR が更新対象になる頻度が下がる。

### 失うもの / 運用上の含意
- **ADR の自己完結性が若干下がる**: 「この cron 式は何？」を知るには ADR → コード定数へ 1 ホップ必要。ただしコード定数名は ADR 本文に書かれるため辿りやすさは保たれる。
- **レビュー負荷**: 新規コメント / ADR 追加時に「値を書いていないか」を確認する工程が増える。機械検出は本 ADR では扱わない。
- **既存違反の一括修正が必要**: 本 ADR 採択時点で検出された既存違反（ADR-0007 内リテラル、src コメント内リテラル）は修正する。

## Alternatives considered
- **現状維持（ADR-0010 原則 3 のみ）**: 「SSoT を再記述しない」という一般規則では「リテラル値は書かない」という具体判断が各人に委ねられ、実際に drift が発生している。本 ADR で taxonomy を明示する方が実効性が高い。
- **コード側にも ADR 番号を禁止**: コードから ADR 参照を消し、ADR 側に「この決定は `src/config.ts:L7` に適用される」とコード参照を持たせる案。コード側の grep で ADR に辿れなくなり、AI エージェントの参照経路が断たれるため却下。
- **リテラル検出 lint の同時導入**: 正規表現で cron 式 / HH:MM をコメントから検出する lint rule を追加する案。効果はあるが**本 ADR では規約のみ規定**し、lint 実装は痛みの大きさを見てから別 ADR で判断する。YAGNI を優先。
- **ADR を全面的にコード近傍（JSDoc）へ移す**: ADR のファイル管理コストを下げる案。rationale の長文・代替案却下理由が TSDoc に収まらず、またファイルまたぎの判断（e.g. scheduler + DB をまたぐ決定）が表現しづらい。却下。
