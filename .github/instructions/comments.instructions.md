---
applyTo: "{src,tests}/**/*.ts"
---

# Comment & Naming Rules

`src/**/*.ts` と `tests/**/*.ts` のコメント・ネーミング規約。AI が日常的に読み書きする前提で、検索性・トークン効率・誤読防止を優先する。根拠 ADR-0010。

## 原則（優先順）
1. **ネーミングで伝える**。関数名・型名・定数名で意図が伝われば書かない。不足ならまずリネーム。
2. **WHY のみ書く**。コードから自明な WHAT/HOW を繰り返さない。invariant / race / 仕様根拠 / 過渡期の妥協だけコメント化。
3. **SSoT を再記述しない**。仕様は `requirements/base.md`、根拠は `docs/adr/NNNN-*.md`、規約は `.github/instructions/*.md`。コード近傍はラベル + `@see ADR-NNNN` だけ。
4. **リテラル値を書き写さない**（ADR-0022）。cron 式・HH:MM・閾値・状態名・schema 列名などの**実行される値**はコード定数（`src/config.ts` / `src/env.ts` / `src/db/schema.ts` / discriminated union）が唯一の SSoT。ADR/コメントは pointer のみ。引用した瞬間 drift 源になる。
5. **grep できる語彙で書く**。下表のプレフィックスを使い、独自を増やさない。

## TSDoc（英語）
「モジュール境界を越える export + 非自明な契約」にのみ付与。内部 helper / 1 ファイル限定の private / 自明 getter には付けない。

付与対象:
- 公開 repository / service / handler（`transitionStatus` / `sendAskMessage` / `handleInteraction` 等）
- 状態遷移を伴う関数（CAS / 冪等 / race 解決方針）
- 時刻・週キー・締切のような非自明 invariant を持つ関数
- zod スキーマ（他モジュールが narrow 根拠として依存する定義）

本体は英語で簡潔。業務制約は `@remarks` に書き、根拠は `@see` で ADR / requirements / related function へリンク。`@param name - the name` のような冗長列挙禁止。

```ts
/**
 * Transition a session's status via compare-and-swap.
 *
 * @remarks
 * CAS primitive. `undefined` は「既に別ハンドラが遷移させた (race lost)」の意。
 * 呼び出し側は状態を巻き戻さず、DB 再取得して最新状態から続行する。
 * @see ADR-0001
 */
```

## 通常コメント（日本語）
1〜数行近傍の非自明ポイントを書く。形式: `// <prefix>: <本文>`（半角スペース 1）。複数行は `//` を前置（`/* */` は使わない）。

### プレフィックス語彙（必ずいずれかを使う）

| prefix | 用途 |
|---|---|
| `// why:` | 方針選択の理由・代替案却下の根拠 |
| `// invariant:` | 近傍で維持されるべき不変条件 |
| `// race:` | 同時実行・競合下の振る舞い（cron × interaction / 同時押下） |
| `// idempotent:` | 冪等性の担保方法（条件付き UPDATE / unique / CAS） |
| `// jst:` | JST 固定の明示 |
| `// iso-week:` | ISO week / 年跨ぎの注意 |
| `// state:` | 状態遷移・許可遷移・終端到達条件 |
| `// source-of-truth:` | DB / Discord / cron の間で何が正本か |
| `// ack:` | Discord 3 秒制約・defer/reply の選択理由 |
| `// unique:` | DB unique 制約とその役割 |
| `// tx:` | transaction 境界の意図 |
| `// single-instance:` | Fly 単一インスタンス前提への依存 |
| `// deploy-window:` | デプロイ禁止窓（金 17:30〜土 01:00 JST） |
| `// redact:` | ログ redact・secrets 露出防止 |
| `// secret:` | 秘匿値の取扱注意（値は書かない） |
| `// hack:` | 原則に反する暫定対応（**ADR 番号必須**） |
| `// todo(ai):` | 仕様未確定・後追い課題（PR「要確認事項」と対応） |
| `// regression:` | 過去バグの回帰コード（テストでは `it` 名を優先） |

## module preamble（ファイル先頭）
原則**書かない**。ファイル内の関数群が「1 つのオーケストレーション責務」で、責務がファイル名から読み取りにくく、他モジュールとの境界俯瞰が必要なときのみ 2〜4 行で置く。長大な責務一覧や目次は書かない。

## 削除対象（見つけたら消す）
- コードから自明な WHAT 列挙コメント
- 実装と乖離した古い説明
- 装飾区切り（`// ======` 単独行、空行 TSDoc）

## ネーミング

### 動詞辞書（関数名 prefix）
意味を固定。違反はリネーム。

| prefix | 意味 | 例 |
|---|---|---|
| `build*` | **pure**（I/O なし）、入力から値を組み立てる | `buildAskRow` |
| `render*` | pure、表示用データへ整形 | `renderAskBody` |
| `send*` | **副作用あり**（Discord/HTTP/DB 書き込み） | `sendAskMessage` |
| `find*` | DB read、0〜N 件（null/undefined/配列） | `findDueAskingSessions` |
| `get*` | 必ず値が返る pure accessor（I/O なし） | `getMemberLabel` |
| `try*` | 条件付き成功（前提未満は no-op/undefined） | `tryDecideIfAllTimeSlots` |
| `handle*` | 入口ハンドラ（interaction/cron tick） | `handleInteraction` |
| `run*Tick` | cron 駆動の 1 回実行単位 | `runScheduledAskTick` |
| `create*` | 新規エンティティ生成（DB 書き込み含む） | `createAskSession` |
| `upsert*` | 既存更新 / 無ければ作成 | `upsertResponse` |
| `settle*` | 締切後に最終状態へ収束 | `settleAskingSession` |
| `transition*` | 状態遷移（CAS で 1 段） | `transitionStatus` |

### 型・定数・ファイル
- 型名 `PascalCase`。DB 行は Drizzle の `$inferSelect`（独自 alias 禁止）。
- 定数マップは「from → to」を名に含める: `ASK_CUSTOM_ID_TO_DB_CHOICE`（✗ `ASK_CHOICE_MAP`）。
- ファイル名 `camelCase.ts`。1 ファイル 1 責務。300 行超で分割検討。

### 業務語彙（リネーム禁止）
`weekKey` / `postponeCount` / `decidedStartAt` / `candidateDateIso` / `ASKING` / `POSTPONE_VOTING` / `POSTPONED` / `DECIDED` / `CANCELLED` / `COMPLETED` / `SKIPPED` / `MEMBER_USER_IDS` / 時刻スロット値 / `absent`。`requirements/base.md` の SSoT。

## テスト
- 仕様は `describe`/`it` 名で語る。コメントより先にテスト名を整える。
- `it` 名は「何を保証するか」を 1 行で。WHY コメントは invariant が非自明なときのみ。
- 業務 invariant の回帰テスト（ISO week 年跨ぎ / `POSTPONE_DEADLINE` 境界 / `custom_id` 不正形式 等）には `// regression:` を付け削除防止。
- `vi.mock(...)` は何を差し替え何を検証するかを 1 行で書く。
