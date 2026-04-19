---
applyTo: "{src,tests}/**/*.ts"
---

# Runtime Rules (TypeScript / Node 24)

> 時刻仕様・状態名・`custom_id` 形式は `requirements/base.md` §10/§13/§14 を正本とする。本書は実装作法のみを扱う。

## 型システム
- `tsconfig.json` では `strict: true`、`noImplicitAny: true`、`exactOptionalPropertyTypes: true` を前提に実装しろ。設定を弱める提案、局所無効化、`// @ts-ignore` の常用をするな。
- `any` を導入するな。外部入力、DB から復元した JSON、Discord payload、`custom_id`、環境変数派生値は、まず `unknown` で受け、`zod` で narrow しろ。
- `as` キャストは最後の手段にしろ。`as Session`、`as never`、二重キャストで型不一致を黙らせるな。Do: `schema.parse(input)` / Don't: `input as Session`。
- Union は判別可能にしろ。`status` / `kind` / `type` などの discriminant を持たせ、真偽値の組み合わせで意味を表す曖昧な型を作るな。`switch` の `default` は `assertNever(x)` で exhaustive にしろ。
- Optional は「未設定」と「`undefined` を明示代入」を区別しろ。`exactOptionalPropertyTypes` を前提に、`foo?: string` へ安易に `undefined` を代入するな。
- 公開関数・repository・service・handler の返り値型は明示しろ。定数マップ・command 定義は `as const satisfies ...` を使え。DTO / config は `Readonly` を優先しろ。

## 時刻・タイムゾーン
- アプリ起動直後に `process.env.TZ = "Asia/Tokyo"` を確定しろ。テストも同じ前提で動かせ。
- 「現在時刻の取得」「週キー算出」「候補日計算」「`POSTPONE_DEADLINE` 解釈」は `src/time/` に集約しろ。他コードから `new Date()` / `Date.parse()` / 文字列連結で日付を生成するな。必ず時間モジュール経由。
- ISO week は `date-fns/getISOWeek` と `getISOWeekYear` を併用しろ。年跨ぎの金曜・土曜で ISO year が変わる前提でテストを書け。`YYYY-Www` を自作するな。
- `POSTPONE_DEADLINE="24:00"` は「候補日翌日 00:00 JST」のみとして解釈しろ。`25:00` など 24 超え表記を受け入れるな。
- 現在時刻は fake timers または関数 DI で差し替え可能にしろ。時刻依存ロジックを直接グローバル時計に結びつけるな。

## 環境変数（zod v4 で起動時 validate）
- `src/env.ts` に zod v4 スキーマを定義し、起動時に一度だけ parse しろ。失敗を起動後まで遅延させるな。
- 起動時 invariant（env / config）は `parse()` を使え。parse 失敗時は人間が読める内容を `stderr` へ出し、必ず `process.exit(1)` で停止しろ。
- アプリコードは `env.XXX` だけを参照しろ。`process.env` を直接読むコードを追加するな。
- `DIRECT_URL` は `src/env.ts` のアプリ実行時 env には含めず、`drizzle.config.ts` でのみ扱え。`requirements/base.md` §13.3 の zod 例は「必要 env 一覧」の例示であり、アプリ側 env スキーマに `DIRECT_URL` を加える根拠ではない。
- `HEALTHCHECK_PING_URL` は任意。未設定時は ping を no-op にしろ。
- カンマ区切り値・時刻文字列・整数分数も `zod` で parse 済みの型として export しろ。呼び出し側で都度 split や `parseInt` を繰り返すな。数値文字列は `zod` で形式検証してから変換しろ。`Number('')` や radix 未指定 `parseInt` に依存するな。

```ts
const env = envSchema.parse(process.env);
export { env };
```

## ロギング（pino）
- ログは `pino` で stdout に構造化 JSON を出せ。人間向け整形ログを常設するな。
- `sessionId` / `weekKey` / `interactionId` / `messageId` / `userId` は値が存在する場面で必ず付与しろ。キー名を揺らすな。
- 状態遷移ログには `from` / `to` / `reason` を含めろ。
- token / 接続文字列 / `Authorization` は redact しろ。interaction payload 全体を丸ごと出すな。必要最小限のフィールドだけ抽出しろ。
- `console.log` / `console.error` を残すな。`logger` に統一しろ。

## エラー処理
- 業務エラーと実行時エラーを分けろ。仕様上の「中止」「順延 NG」は状態遷移で表現し、throw するな。
- 実行時エラーは handler 境界で catch し、log し、可能なら ephemeral で失敗を返せ。
- cron tick は必ず最外周を `try/catch` で包め。例外を次 tick に持ち越すな。落ちた tick は次 tick で再計算できるよう DB を正本にしろ。
- Discord API 失敗と DB 失敗を同列に扱うな。DB 更新済みなら状態を維持し、再描画は再試行で回復させろ。
- ユーザー入力・Discord payload は `safeParse()` を使い、失敗時は `error.issues[*].path` を整形して log し、状態変更せず却下しろ。
- 裸の Promise を残すな。独立 I/O は `Promise.all`、fire-and-forget は `void task().catch(logger.error)` に限定しろ。

## Discord Interaction ハンドラの骨格
1. 入口で即 `interaction.deferUpdate()` しろ（3 秒制約）。
2. `interaction.guildId` / `interaction.channelId` / `interaction.user.id ∈ env.MEMBER_USER_IDS` を検証しろ。対象外は状態変更せず ephemeral で却下。
3. `custom_id` を `zod` で `safeParse` しろ。失敗なら却下。
4. DB から Session / Response を再取得し、最新状態を正として処理しろ。押下前のメッセージ内容を信用するな。
5. 状態更新は条件付き `UPDATE` とトランザクションで。
6. 再描画は DB の Session + Response から組み立て直し、`interaction.message.edit(...)` で更新しろ。追加通知が必要なときだけ `followUp()`。
7. slash command は **guild-scoped** で同期しろ。

```ts
await interaction.deferUpdate();
const parsed = customIdSchema.safeParse(interaction.customId);
if (!parsed.success) { /* reject */ }
const session = await repo.findSessionById(parsed.data.sessionId);
```

## DB アクセス（Drizzle）
- クエリは Drizzle を使え。SQL は `sql\`\`` テンプレートで組み立て、プレースホルダ自動化を維持しろ。生の `pg` / `postgres` クライアントを直接使うな。
- `sql.raw()` にユーザー入力を渡すな。動的 `ORDER BY` や列名切替はホワイトリスト分岐で実装しろ。
- 状態遷移は `db.transaction(async (tx) => { ... })` と条件付き `UPDATE ... WHERE status = ...` で原子的に処理しろ。read-modify-write を裸で書くな。
- `responses` は `(sessionId, memberId)` unique 制約を前提に二重挿入を防げ。競合時は再取得して再描画しろ。
- cron と interaction が競合する前提で設計しろ。単一インスタンスでも同時押下は起こる。
- アプリ DB クライアントは `env.DATABASE_URL` を使い、Neon pooler 互換のため `postgres(url, { prepare: false })` を明示しろ。
- cron は毎 tick DB から再計算しろ。in-memory 状態を正本にするな。起動時は active session を再読込して締切・リマインドを復元しろ。同一 tick 重複実行でも結果が変わらないよう冪等に。

## Do / Don't（まとめ）
| Do | Don't |
|---|---|
| `unknown` で受けて `zod` で絞る | `any` や雑な `as` で握り潰す |
| 時刻計算を `src/time/` に集約 | 各所で `new Date()` を直接呼ぶ |
| `src/env.ts` で起動時 validate | 実行中に `process.env` を点在参照 |
| `pino` に固定コンテキストを載せる | `console.log` / payload 全量出力 |
| 業務エラーは状態で表現 | 仕様分岐を例外で制御 |
| 入口で `deferUpdate` → 検証 → DB 更新 → 再描画 | 3 秒以内応答を後回し |
| Drizzle transaction と条件付き更新 | 生 SQL や `sql.raw()` に入力直結 |
| unique 制約 + 再取得で競合に耐える | 同時押下を単一スレッド前提で扱う |
| DB を正本に cron を冪等化 | in-memory 状態を信頼する |
