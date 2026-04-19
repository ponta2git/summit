# Copilot Instructions（summit）

> このリポジトリで AI が従う **常時ルール**。詳細手順は `AGENTS.md`、TS 実装規約は `.github/instructions/runtime.instructions.md`、業務仕様の正典は `requirements/base.md`。

## プロジェクト概要
個人開発の **Discord Bot**（固定 4 名の「桃鉄1年勝負」出欠自動化）。金曜 18:00 募集 → 21:30 締切判定 → 欠席/未回答があれば土曜への順延確認まで自動化。単一インスタンス・JST 固定・Neon + Fly.io 運用。

## 最優先ルール（違反禁止）
1. **業務仕様の正典は `requirements/base.md`（§1〜§16）**。矛盾する実装や提案をするな。用語を勝手に変えるな。
2. **JST 固定**: `TZ=Asia/Tokyo`。時刻計算は `src/time/` に集約し、他所で直接 `new Date()` / `Date.parse()` を書くな。`POSTPONE_DEADLINE="24:00"` は「翌日 00:00 JST」のみ。週キーは ISO week/year（年跨ぎ前提）。
3. **アプリ env は `src/env.ts` の zod v4 スキーマで起動時 parse**。アプリコードから `process.env` を直接参照するな。`DIRECT_URL` は `drizzle.config.ts` / migration 文脈のみで扱い、アプリ env に含めるな。`HEALTHCHECK_PING_URL` は任意、未設定時は ping を送らない。
4. **DB は Drizzle + postgres.js**。migration は `drizzle-kit generate` + `migrate` のみ。`drizzle-kit push` 禁止。`sql.raw()` にユーザー入力を渡すな。Neon pooler 向けに `postgres(..., { prepare: false })` を明示。
5. **単一インスタンス前提**: Fly を 2 instance 以上に scale するな。二重起動・`node-cron` の多重登録を避ける。**DB を正本**とし、起動時は active session を再読込して締切・リマインドを復元。in-memory 状態を信頼するな。
6. **Interaction は必ず defer → 検証 → 状態変更**: まず `interaction.deferUpdate()`（3 秒制約）。その後 `guildId` / `channelId` / `user.id ∈ MEMBER_USER_IDS` / `custom_id`（zod で parse）/ session を検証してから状態変更する。検証順は cheap-first を基本とし、詳細は `runtime.instructions.md` / `base.md` §13.2 に従う。対象外は ephemeral で却下。slash command は **guild-scoped** で同期する。
7. **本番破壊的操作禁止**: 本番 DB への `DROP` / `TRUNCATE` / 手動 `UPDATE`、`fly ssh` 経由の生 SQL、secrets 値の上書き・削除を提案するな。`.env*` や token / `DATABASE_URL` / `DIRECT_URL` / `HEALTHCHECK_PING_URL` の実値をコード・fixture・ログ・PR 本文に載せるな。
8. **デプロイ禁止窓**: 金 17:30〜土 01:00 JST はデプロイ・再起動・schema 変更を提案・実行するな。
9. **ログに秘匿値を出すな**: token / 接続文字列 / `Authorization` / interaction payload 全量は禁止。`pino` の redact 前提で、`sessionId` / `weekKey` / `interactionId` / `messageId` / `userId` を構造化フィールドで付与。`console.log` / `console.error` を残すな。

## 技術スタック（確定）
TypeScript / Node 24 LTS / pnpm v10 / mise / discord.js v14 / node-cron / pino / zod v4 / Drizzle 0.45 + postgres.js / drizzle-kit / drizzle-zod / Neon PostgreSQL 16 / Fly.io（単一インスタンス）/ healthchecks.io

## 必読ドキュメント（作業前に必ず参照）
| 目的 | ファイル |
|---|---|
| 業務仕様（正典） | `requirements/base.md` |
| 作業手順・SSoT・禁止領域・落とし穴 | `AGENTS.md` |
| TS/Node 実装ルール（`src`/`tests` に適用） | `.github/instructions/runtime.instructions.md` |
| 入口・ローカル手順 | `README.md` |

## 検証の基本順序
`pnpm typecheck` → `pnpm lint` → `pnpm test` → `pnpm build`（schema/env に触れたら `pnpm db:check` を追加）。代表コマンド・セットアップ手順は `README.md` 参照。

## 仮定プロトコル（推測禁止を現実化）
1. 仕様に明記があれば従う。
2. 明記が無いが **可逆で小さい** 技術判断なら、その場で進めて PR 本文の「仮定」と「要確認事項」に記載。
3. **業務仕様に関わる判断**（締切・週キー・順延ルール・参加条件など）で明記が無ければ、実装せず `// TODO(ai): spec clarification needed - <issue>` を残し、PR の「要確認事項」に書いて質問。
4. いずれの場合も **本番破壊的操作 / デプロイ禁止窓違反 / 秘匿値露出 / 単一インスタンス前提の逸脱** は仮定で進めるな。

## コミット / PR
- Conventional Commits（英語）。
- PR 本文は日本語で「変更点 / 仮定 / 要確認事項 / 影響範囲 / テスト / 運用影響 / リスク」を記載。詳細テンプレは `AGENTS.md`。
- `requirements/base.md` の改変は仕様変更。PR 本文で根拠を明示すること。
