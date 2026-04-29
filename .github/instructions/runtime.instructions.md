---
applyTo: "{src,tests}/**/*.ts"
---

# Runtime Rules (TypeScript / Node 24)

TypeScript/Node 24 実装作法。対象 `{src,tests}/**/*.ts`。時刻・Interaction・DB・Secrets/Logging は各 review file を一次正典とする（重複を避けるため本書では扱わない）。

前提:
- 状態名: `ASKING` / `POSTPONE_VOTING` / `POSTPONED` / `DECIDED` / `CANCELLED` / `COMPLETED` / `SKIPPED`（終端: `COMPLETED` / `SKIPPED`）。
- `custom_id`（Component 限定）: `ask:{sessionId}:{choice}` / `postpone:{sessionId}:{ok|ng}`。

## 型システム
- `strict`/`noImplicitAny`/`exactOptionalPropertyTypes` 前提。設定を弱めない。`@ts-ignore` 常用しない。
- `any` 禁止。外部入力（Discord payload / env 派生 / DB 復元 JSON / `custom_id`）は `unknown` で受け zod で narrow。
- `as` は最後の手段。`schema.parse(input)` を使え。`as never` / 二重キャストで型不一致を黙らせるな。
- Union は discriminated union（`status`/`kind`/`type` 等）にし、`switch` の `default` は `assertNever(x)` で exhaustive に。
- `exactOptionalPropertyTypes` 前提で `foo?: string` に `undefined` を明示代入するな。
- 公開関数/repository/service/handler の返り値型は明示。定数マップ・command 定義は `as const satisfies ...`。DTO/config は `Readonly` 優先。

## 環境変数（zod v4 で起動時 validate）
- `src/env.ts` に zod スキーマを定義し起動時に 1 度 `parse()`。失敗時は stderr に人間可読な内容を出し `process.exit(1)`。
- アプリコードは `env.XXX` のみ参照。`process.env` 直接参照禁止。
- `DIRECT_URL` はアプリ env に含めない（momo-db の `drizzle.config.ts` 専用）。`HEALTHCHECK_PING_URL` 未設定時は ping を no-op。
- カンマ区切り・時刻文字列・整数分数も zod で parse 済みの型として export。呼び出し側で split/`parseInt` を繰り返すな。`Number('')`/radix 未指定 `parseInt` 禁止。

## エラー処理
- 業務エラー（中止 / 順延 NG）は状態遷移で表現し throw しない。
- neverthrow は Interaction handler pipeline と cross-feature orchestration の境界で使う（ADR-0045）。DB / Discord / outbox 等の複数 I/O を順序合成する exported flow は `ResultAsync<..., AppError>` を優先する。
- repository / ports / pure domain を blanket に `ResultAsync` 化しない。CAS race / no-op は `undefined` 等の state return、業務判断は discriminated union を維持し、呼び出し側境界で `fromDatabasePromise()` 等に包む。
- scheduler tick entry は `Promise<void>` を維持し `runTickSafely` で隔離する。`ResultAsync` を返す orchestration は scheduler / handler 境界で unwrap し、`AppError.code` と文脈識別子を構造化ログに含める。
- env/config parse、`assertNever`、impossible state の fail-fast throw は許容する。
- 実行時エラーは handler 境界で catch → log → 可能なら ephemeral 応答。
- cron tick は最外周 `try/catch`。例外を次 tick に持ち越すな。
- Discord API 失敗と DB 失敗を同列に扱うな。DB 更新済みなら状態維持し、再描画は再試行で回復。
- ユーザー入力・Discord payload は `safeParse()`。失敗時は `error.issues[*].path` を整形 log し却下。
- 裸 Promise 禁止。独立 I/O は `Promise.all`、fire-and-forget は `void task().catch(logger.error)` のみ。
