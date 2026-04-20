---
applyTo: "{src,tests}/**/*.ts"
---

# Comment & Naming Rules

本書は summit のソース（`src/**/*.ts`）とテスト（`tests/**/*.ts`）におけるコメントとネーミングの規約を定める。リポジトリは AI エージェント（Codex / Claude Code / Copilot）が日常的に読み書きする前提で、検索性・トークン効率・誤読防止を優先する。判断の根拠は `docs/adr/0010-code-comment-and-naming-conventions.md` を参照。

## 0. 原則（優先順）
1. **ネーミングで伝える**。関数名・型名・定数名・ファイル名で意図が伝わるならコメントを書かない。名前が不足しているならまずリネームを検討する。
2. **WHY のみ書く**。コードから自明に読める WHAT / HOW を繰り返し書かない。非自明な invariant・race condition・仕様根拠・過渡期の妥協だけをコメント化する。
3. **SSoT を再記述しない**。業務仕様は `requirements/base.md`、設計判断は `docs/adr/NNNN-*.md`、実装規約は `.github/instructions/*.md` にある。コード近傍では一言ラベル + リンク（`@see ADR-0007` 等）で済ませる。
4. **リテラル値を ADR / コメントに書き写さない**。cron 式・HH:MM 時刻・閾値・状態名・schema 列名などの**実行される値**はコード定数（`src/config.ts` / `src/env.ts` / `src/db/schema.ts` / discriminated union）が唯一の SSoT。ADR とコメントは **pointer のみ**とし、値を引用した瞬間に drift 源になると認識する。詳細は **ADR-0022（SSoT taxonomy）** を参照。
5. **トークン効率を意識する**。冗長なセクション見出し、形式的な `@param` 列挙、装飾だけのコメントを置かない。AI が読み飛ばしても判断に支障がない量まで削る。
6. **grep できる語彙で書く**。後述のプレフィックス表を使い、検索で一発で呼び出せるようにする。

## 1. コメントの書き分け

### 1.1 TSDoc を付ける場所（English）
TSDoc は「モジュール境界を越える export + 非自明な契約」にのみ付与する。内部 helper、1 ファイルから使われる private 関数、自明な getter / thin wrapper には付けない。

付与対象の例:
- 公開 repository / service / handler の関数（`transitionStatus`、`sendAskMessage`、`handleInteraction` など）。
- 状態遷移を伴う関数（CAS・冪等性・race 解決方針が説明対象）。
- 時刻・週キー・締切計算のような非自明な invariant を持つ関数。
- zod スキーマなど、他モジュールが narrow の根拠として依存する定義。

本体は英語で簡潔に。**業務制約は `@remarks` に書き、英語でも日本語でも可**（仕様語は日本語のまま扱って良い）。**根拠は `@see` で ADR / requirements / related function へリンク**する。

```ts
/**
 * Transition a session's status via compare-and-swap.
 *
 * @remarks
 * CAS primitive. `undefined` を返したら「既に別ハンドラが遷移させた（race lost）」を意味する。
 * 呼び出し側は状態を巻き戻さず、DB 再取得して最新状態から処理を続行する。
 * @see ADR-0001 single-instance-db-as-source-of-truth
 */
export async function transitionStatus(...): Promise<Session | undefined> { ... }
```

TSDoc 禁止項目:
- 実装を読めば自明な `@param name - the name` のような冗長な列挙。
- `@returns` で型情報を言い換えるだけの記述。
- コードが既に説明している `@example`（他モジュールから使い方が非自明な場合のみ許容）。

### 1.2 通常コメントを付ける場所（日本語）
コード 1〜数行近傍の非自明ポイントを日本語で書く。業務仕様・過渡期の妥協・race / 冪等 / 単一インスタンス前提などの運用ランドマインを残す目的。

形式:
- 行頭 `//` + 小文字プレフィックス + `:` + 半角スペース + 日本語本文。
- 複数行になる場合は `//` を前置し続ける（`/* */` はコード注釈では使わない）。
- 句点（`。`）を付ける／付けないはファイル内で統一する。既存ファイルの慣習に合わせる。

### 1.3 プレフィックス語彙（grep tag）
後から検索・機械抽出するためのラベル。新規作成時は必ずこの表のいずれかを使う。独自プレフィックスを増やさない。

| prefix | 用途 |
|---|---|
| `// why:` | 選択肢の中でこの方針を取った理由（代替案の却下理由含む） |
| `// invariant:` | コード近傍で維持されるべき不変条件 |
| `// race:` | 同時実行・競合下での振る舞い（cron × interaction、4 名同時押下 等） |
| `// idempotent:` | 冪等性の担保方法（条件付き UPDATE / unique 制約 / CAS 等） |
| `// jst:` | JST 固定であることの明示（時刻計算・表示） |
| `// iso-week:` | ISO week / 年跨ぎに関する注意 |
| `// state:` | 状態遷移の流れ・許可遷移・終端状態への到達条件 |
| `// source-of-truth:` | DB / Discord / cron の間で何が正本かを明示 |
| `// ack:` | Discord interaction の 3 秒制約・defer/reply の選択理由 |
| `// unique:` | DB の unique 制約とその役割 |
| `// tx:` | transaction 境界の意図 |
| `// single-instance:` | Fly 単一インスタンス前提に依存している事実 |
| `// deploy-window:` | デプロイ禁止窓（金 17:30〜土 01:00 JST）に関する制約 |
| `// redact:` | ログ redact・secrets 露出防止の根拠 |
| `// secret:` | 秘匿値の取り扱いの注意（値そのものは書かない） |
| `// hack:` | 原則に反する暫定対応（**ADR 必須**。本文に ADR 番号を書く） |
| `// todo(ai):` | 仕様未確定・後追い必要な課題（PR 本文「要確認事項」と対応させる） |
| `// regression:` | 過去のバグを防ぐ回帰コード（テストでは `it` 名で説明するのが第一候補） |

例:
```ts
// invariant: findSessionByWeekKeyAndPostponeCount が同一 week × postponeCount で 1 件以下を返すのは
//   sessions.(weekKey, postponeCount) の unique 制約によって担保される。
// unique: (sessionId, memberId) で Response 二重投入を排除。同時押下時は後発が unique 違反→再取得して再描画。
// race: cron tick と interaction handler が同じ session を見に来る。transitionStatus の CAS で勝者のみが副作用実行。
// ack: Component interaction は 3 秒以内に deferUpdate() しないと失敗する。検証より先に ack する。
// jst: POSTPONE_DEADLINE="24:00" は「候補日翌日 00:00 JST」としてのみ解釈する。
// hack: ADR-0007 により cron 式は現状 `0 8 * * 5` (金 08:00 JST)。requirements の 18:00 記述との同期は別課題。
// todo(ai): spec clarification needed - 5 人目メンバー参加時の扱い
```

### 1.4 module preamble（ファイル先頭コメント）
原則として**書かない**。以下の条件をすべて満たすファイルに限り、2〜4 行で簡潔に置く:
- ファイル内の関数群が「1 つのオーケストレーション責務」を担う（scheduler / interactions handler など）。
- 責務がファイル名だけからは読み取りにくい。
- 他モジュールとの境界（DB / Discord / cron / shutdown）の絡みを俯瞰する必要がある。

長大な責務一覧や目次は書かない。代替として該当ファイル内の主要関数に短い TSDoc を付ける。

### 1.5 削除対象
PR レビュー中に以下を見つけたら、本タスクのついでで削除して良い:
- コードから自明な WHAT 列挙コメント。
- 実装と乖離した古い説明（意図が掴めないものは git blame で根拠を確認し、残すか消すかを判定）。
- 装飾区切り（`// ======` だけの行、意味のない空行 TSDoc）。

## 2. ネーミング

### 2.1 動詞辞書（関数名の prefix）
意味を固定する。違反する場合はリネームする。

| prefix | 意味 | 例 |
|---|---|---|
| `build*` | **pure**（I/O なし）、入力から値を組み立てるだけ | `buildAskRow`, `buildPostponeRow` |
| `render*` | pure、表示用データへ整形 | `renderAskBody`, `renderPostponeBody` |
| `send*` | **副作用あり**（Discord / HTTP / DB 書き込み） | `sendAskMessage` |
| `find*` | DB read、0〜N 件返す（null / undefined / 配列） | `findSessionByWeekKeyAndPostponeCount`, `findDueAskingSessions` |
| `get*` | 必ず値が返る pure accessor（外部 I/O なし） | `getMemberLabel` |
| `try*` | 条件付き成功（前提を満たさないときは no-op または undefined） | `tryDecideIfAllTimeSlots` |
| `handle*` | 入口ハンドラ（interaction / cron tick） | `handleInteraction`, `handleButton` |
| `run*Tick` | cron から駆動される 1 回実行単位 | `runScheduledAskTick`, `runDeadlineTick` |
| `create*` | 新規エンティティ生成（DB 書き込みを含む） | `createAskSession` |
| `upsert*` | 既存があれば更新、無ければ作成 | `upsertResponse` |
| `settle*` | 締切到来後に最終状態へ収束させる処理 | `settleAskingSession` |
| `transition*` | 状態遷移（CAS で 1 段遷移） | `transitionStatus` |

### 2.2 型・定数・ファイル命名
- 型名は `PascalCase`、DB 行は `XxxRow` ではなく Drizzle の `$inferSelect` を使う（独自 alias を増やさない）。
- 定数マップは「from → to」を名前に含める: `ASK_CUSTOM_ID_TO_DB_CHOICE`（✗ `ASK_CHOICE_MAP`）。
- ファイル名は `camelCase.ts`（既存慣習）。1 ファイル 1 責務、300 行を超えたら分割を検討する。

### 2.3 業務語彙（不変）
以下は `requirements/base.md` の SSoT 語彙として**リネーム禁止**:
`weekKey` / `postponeCount` / `decidedStartAt` / `candidateDateIso` / `ASKING` / `POSTPONE_VOTING` / `POSTPONED` / `DECIDED` / `CANCELLED` / `COMPLETED` / `SKIPPED` / `MEMBER_USER_IDS` / 時刻スロット `22:00 / 22:30 / 23:00 / 23:30` / `absent`。

## 3. テスト（`tests/**/*.ts`）
- **仕様は `describe` / `it` の名前で語る**。コメントより先にテスト名を整える。
- `it` 名は「何を保証するか」を 1 行で。WHY をコメントで補足するのは invariant が非自明なケースのみ。
- ISO week 年跨ぎ・POSTPONE_DEADLINE 境界・custom_id 不正形式など、**業務 invariant の回帰テスト**には `// regression:` を付ける（削除防止のシグナル）。
- `vi.mock(...)` を使う場合、何を差し替え何を検証したいのかを 1 行で書く。

## 4. Before / After サンプル

### 4.1 WHAT → WHY 書き換え
```ts
// ✗ Before (WHAT、自明)
// sessions から指定 weekKey のレコードを探す
export async function findSessionByWeekKey(...) { ... }

// ✓ After (名前で WHAT を伝え、コメントは invariant のみ)
// invariant: sessions.(weekKey, postponeCount) の unique 制約により 0..1 件。呼び出し元は配列を期待しない。
export async function findSessionByWeekKeyAndPostponeCount(...) { ... }
```

### 4.2 TSDoc の密度
```ts
// ✗ Before (冗長・WHAT の言い換え)
/**
 * Settle an asking session.
 * @param sessionId - The session id.
 * @param now - The current time.
 * @returns The settled session.
 */

// ✓ After (WHY / 冪等 / 根拠)
/**
 * Settle an ASKING session that has passed its deadline.
 *
 * @remarks
 * Idempotent. 締切通過済み session を対象に CAS で状態遷移を行い、
 * 勝者（CAS 成功側）のみが Discord メッセージ編集と postpone 送信を実行する。
 * cron tick の重複実行でも結果は同じ。
 * @see ADR-0001 single-instance-db-as-source-of-truth
 */
export async function settleAskingSession(...) { ... }
```

### 4.3 プレフィックス + 仕様根拠
```ts
// ✗ Before (根拠がない)
// postgres の設定
const sql = postgres(url, { prepare: false, max: 5 });

// ✓ After (grep tag + 根拠)
// why: Neon の PgBouncer (transaction pooling) は prepared statement を共有できないため prepare:false を明示。
// invariant: 単一インスタンス前提。max:5 は cron / interaction 並走時の上限として十分。
// @see ADR-0003 postgres-drizzle-operations
const sql = postgres(url, { prepare: false, max: 5 });
```

### 4.4 module preamble が妥当なケース
```ts
// src/scheduler/index.ts
// 役割: cron 登録 + scheduled/deadline/startup recovery の 3 tick を束ねるオーケストレータ。
// source-of-truth: 各 tick は DB から再計算する。in-memory 状態に依存しない。
// single-instance: cron は node-cron を 1 プロセス 1 回だけ登録する前提。
// @see ADR-0001 / ADR-0007
```

## 5. レビューチェックリスト
- [ ] 新規コメントはプレフィックス語彙のいずれかで始まっているか。
- [ ] ネーミングで伝わる内容を、コメントで重複して書いていないか。
- [ ] TSDoc は境界越え export + 非自明 invariant に限定されているか（内部 helper に付いていないか）。
- [ ] `@see` / ADR リンクで SSoT に辿れるか（本文で仕様を再記述していないか）。
- [ ] `// hack:` には ADR 番号が書かれているか。
- [ ] 業務語彙（`weekKey` 等）をリネームしていないか。
- [ ] テストは `describe` / `it` 名で仕様を語っているか。
- [ ] secrets / token / 接続文字列の実値がコメントに含まれていないか。
