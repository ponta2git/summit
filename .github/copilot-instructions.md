# Copilot Instructions（summit）

このリポジトリで AI が従う **常時ルール**の要約。作業手順・SSoT 表・仮定/ADR プロトコル・既知の落とし穴は `AGENTS.md` に集約。業務仕様は `requirements/base.md`、実装規約は `.github/instructions/*.md`、判断根拠は `docs/adr/`。

## プロジェクト概要
個人開発の **Discord Bot**（固定 4 名の桃鉄 1 年勝負 出欠自動化）。金曜朝に募集自動投稿 → 当日締切判定 → 順延 1 回。対象は `env.DISCORD_CHANNEL_ID` 1 チャンネル + `env.MEMBER_USER_IDS` 4 名固定。TZ は `Asia/Tokyo`。時刻・スケジュール値の現在値は `src/config.ts` / `src/env.ts` / `requirements/base.md` を参照（ADR/コメントに書き写さない、ADR-0022）。

## 最優先ルール（違反禁止）
1. **JST 固定**。起動時 `process.env.TZ = "Asia/Tokyo"`。時刻計算・週キー・締切は `src/time/` に集約、他所で `new Date()` 禁止。ISO week は `date-fns/getISOWeek` + `getISOWeekYear` 併用（年跨ぎ担保）。`POSTPONE_DEADLINE="24:00"` は「候補日翌日 00:00 JST」のみ。
2. **env は `src/env.ts` の zod v4 で起動時 parse**。アプリコードから `process.env` 直接参照禁止。`DIRECT_URL` は `drizzle.config.ts` 専用。`HEALTHCHECK_PING_URL` 未設定時は ping を no-op。
3. **DB は Drizzle + postgres.js**。migration は `drizzle-kit generate` + `migrate` のみ（`push` 禁止）。`sql.raw()` に入力を渡さない。Neon pooler 互換で `postgres(url, { prepare: false })` 明示。状態遷移はトランザクション + 条件付き `UPDATE ... WHERE status = ...`。`responses` は `(sessionId, memberId)` unique で二重投入排除。
4. **単一インスタンス前提**。Fly app を scale しない。`node-cron` を多重登録しない。**DB を正本**とし in-memory 状態を信頼しない。起動時に非終端 Session を再読込。cron は毎 tick DB から再計算して冪等に。
5. **Interaction は defer → 検証 → DB 更新 → DB から再描画**。Component は `deferUpdate()`、Slash command は `deferReply()/reply()`（3 秒制約）。cheap-first 順: `guildId` → `channelId` → `user.id ∈ MEMBER_USER_IDS` → `custom_id` を zod `safeParse` → DB から Session 再取得。対象外は状態を変えず ephemeral で却下。slash command は **guild-scoped bulk overwrite** 同期（global 禁止）。
6. **本番破壊操作・秘匿値露出禁止**。本番 DB への `DROP`/`TRUNCATE`/手動 `UPDATE`、`fly ssh` 生 SQL、`fly secrets unset`/上書きを実行しない。token / `DATABASE_URL` / `DIRECT_URL` / `HEALTHCHECK_PING_URL` の実値をコード・fixture・ログ・PR・コミットに載せない（commit 可は `.env.example` のみ）。
7. **デプロイ禁止窓**: 金 17:30〜土 01:00 JST は deploy / restart / schema 変更を提案・実行しない。
8. **ログに秘匿値を出さない**。`pino` の `redact` で token/接続文字列/`Authorization` を除去。interaction payload 全量を出さない。`sessionId` / `weekKey` / `interactionId` / `messageId` / `userId` を構造化フィールドで付与。状態遷移は `from`/`to`/`reason`。`console.log/error` 残さない。
9. **型・エラー処理**。`any` 導入禁止、外部入力は `unknown` → zod narrow。`as` キャスト最小。業務エラー（中止・順延 NG 等）は状態で表現し throw しない。cron tick は最外周 `try/catch`。裸 Promise 禁止。
10. **依存は AppContext 経由で注入**。handler/scheduler/workflow は `src/db/repositories/*` や `src/db/client` を直接 import せず、`AppContext = { ports, clock }`（`src/appContext.ts`）を受け取り `ctx.ports.*`/`ctx.clock` を使う。production は `src/index.ts` の `createAppContext()`、テストは `tests/testing/ports.ts` の `createTestAppContext({ seed, now })` で Fake ports を注入（`vi.mock` を repositories に新規追加しない）。純粋関数は対象外。根拠 ADR-0018。

## 技術スタック
TypeScript / Node 24 / pnpm v10 / mise / discord.js v14 / node-cron / pino / zod v4 / Drizzle 0.45 + postgres.js / drizzle-kit / drizzle-zod / Neon PostgreSQL 16 / Fly.io（単一インスタンス）/ healthchecks.io

## 検証順序
`pnpm typecheck` → `pnpm lint` → `pnpm test` → `pnpm build`（schema/env 変更時は `pnpm db:check` 追加）。

## コミット / PR
- Conventional Commits（英語）。
- PR 本文は日本語で「変更点 / 仮定 / 要確認事項 / 影響範囲 / テスト / 運用影響 / リスク」を記載（テンプレ詳細は `AGENTS.md`）。
