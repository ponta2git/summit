# Copilot Instructions（summit）

このリポジトリで AI が従う **常時ルール**。業務仕様は `requirements/base.md`、手順は `AGENTS.md`、実装規約は `.github/instructions/*.md`（applyTo ベースで適用）、判断の根拠は `docs/adr/`。本書は他文書を参照せずに判断できるよう、判断に必要な要約を含める。

## プロジェクト概要
個人開発の **Discord Bot**（固定 4 名の「桃鉄1年勝負」出欠自動化）。
- 金曜 18:00 JST に募集自動投稿 → 21:30 JST 締切判定 → 欠席/未回答があれば土曜同時間帯へ順延確認（順延は 1 回まで）。
- 対象メンバーは `env.MEMBER_USER_IDS` の Discord user ID 4 名固定。投稿・操作は `env.DISCORD_CHANNEL_ID` 1 チャンネルのみ。
- タイムゾーンは `Asia/Tokyo` 固定。週キーは ISO week/year（`YYYY-Www`）で、金曜 Session と順延先の土曜 Session は同一週キーを共有する。

## 最優先ルール（違反禁止）
1. **JST 固定**。`process.env.TZ = "Asia/Tokyo"` を起動時に確定。時刻計算・週キー算出・締切・リマインド計算はすべて `src/time/` に集約し、他所で `new Date()` / `Date.parse()` / 文字列連結で日付を作らない。`POSTPONE_DEADLINE="24:00"` は「候補日翌日 00:00 JST」のみとして解釈する（`25:00` 等は不可）。ISO week は `date-fns/getISOWeek` と `getISOWeekYear` を併用し年跨ぎを担保。
2. **アプリ env は `src/env.ts` の zod v4 スキーマで起動時 parse**。アプリコードから `process.env` を直接参照しない。`DIRECT_URL` は `drizzle.config.ts` 専用でアプリ env に含めない。`HEALTHCHECK_PING_URL` は任意、未設定時は ping を no-op。
3. **DB は Drizzle + postgres.js**。migration は `drizzle-kit generate` + `drizzle-kit migrate` のみ（`drizzle-kit push` 禁止）。`sql.raw()` にユーザー入力を渡さない。Neon pooler 互換のため `postgres(url, { prepare: false })` を明示。状態遷移はトランザクション + 条件付き `UPDATE ... WHERE status = ...`。Response は `(sessionId, memberId)` unique 制約で二重投入を排除。
4. **単一インスタンス前提**。Fly app を 2 instance 以上に scale しない。`node-cron` を多重登録しない。**DB を正本**とし、起動時は進行中 Session を再読込して締切・リマインドを復元。in-memory 状態を信頼しない。cron は毎 tick DB から再計算し、同一 tick 重複でも結果が変わらないよう冪等にする。
5. **Interaction は必ず defer → 検証 → 状態変更 → DB から再描画**。
   - 入口で即 ack（3 秒制約）: Component / Button は `interaction.deferUpdate()`、Slash command は `interaction.deferReply({ ephemeral: true })` または `interaction.reply(...)`。
   - cheap-first 検証順: `guildId` → `channelId` → `user.id ∈ env.MEMBER_USER_IDS` → `custom_id` を zod `safeParse` → DB から Session 再取得して状態確認。
   - 対象外は状態を変えず ephemeral で却下。
   - 再描画は常に DB の Session + Response から組み立てる。interaction 経由は `interaction.message.edit(...)`、cron 等 interaction 非依存経路は保存済み `channelId` / `messageId` から fetch して `message.edit(...)`。
   - slash command は **guild-scoped bulk overwrite** で同期（global 禁止）。
6. **本番破壊的操作禁止**。本番 DB への `DROP` / `TRUNCATE` / 手動 `UPDATE`、`fly ssh` 経由の生 SQL、`fly secrets unset` / 既存 secrets の上書きを提案・実行しない。`.env*` の実値ファイル、token、`DATABASE_URL`、`DIRECT_URL`、`HEALTHCHECK_PING_URL` の実値をコード・fixture・ログ・PR 本文・コミットメッセージに載せない（commit 可は `.env.example` 雛形のみ）。
7. **デプロイ禁止窓**: 金 17:30〜土 01:00 JST はデプロイ・再起動・schema 変更を提案・実行しない。
8. **ログに秘匿値を出さない**。`pino` の redact で token / 接続文字列 / `Authorization` を除去。interaction payload 全量を出さない。`sessionId` / `weekKey` / `interactionId` / `messageId` / `userId` を構造化フィールドで付与。状態遷移は `from` / `to` / `reason` を含める。`console.log` / `console.error` を残さない。
9. **型・エラー処理**。`any` を導入せず外部入力は `unknown` → `zod` narrow。`as` キャストを最後の手段に。業務エラー（中止・順延 NG 等）は状態で表現し throw しない。cron tick は最外周 `try/catch`。裸 Promise を残さない。

## 技術スタック（確定）
TypeScript / Node 24 LTS / pnpm v10 / mise / discord.js v14 / node-cron / pino / zod v4 / Drizzle 0.45 + postgres.js / drizzle-kit / drizzle-zod / Neon PostgreSQL 16 / Fly.io（単一インスタンス）/ healthchecks.io

## 検証の基本順序
`pnpm typecheck` → `pnpm lint` → `pnpm test` → `pnpm build`（schema / env に触れたら `pnpm db:check` を追加）。

## 仮定プロトコル（推測禁止を現実化）
1. 仕様に明記があれば従う。
2. 明記が無いが **可逆で小さい** 技術判断なら進めて PR 本文の「仮定」「要確認事項」に記載。
3. **業務仕様に関わる判断**（締切・週キー・順延ルール・参加条件・状態・`custom_id` 形式など）で明記が無ければ、実装せず `// TODO(ai): spec clarification needed - <issue>` を残し PR の「要確認事項」に書いて質問。
4. いずれの場合も **本番破壊的操作 / デプロイ禁止窓違反 / 秘匿値露出 / 単一インスタンス前提の逸脱** は仮定で進めない。

## コミット / PR
- Conventional Commits（英語）。
- PR 本文は日本語で「変更点 / 仮定 / 要確認事項 / 影響範囲 / テスト / 運用影響 / リスク」を記載。

## ADR 作成プロトコル（設計判断は逐次記録）
**設計判断を行ったら、その PR 内で ADR を新規作成または更新する**。判断を忘れないためのローカル専用ルールではなく、`docs/adr/` に永続化するまでが 1 つの作業単位。

1. **ADR 化が必要な判断の例**（いずれかに該当したら必ず作る）:
   - 業務仕様に影響する決定（締切・週キー・順延・参加条件・状態・`custom_id` 形式・手動/自動経路の扱い等）。
   - アーキテクチャ層の選択（ライブラリ採用・永続化方式・スケジューラ方式・並行制御方式など）。
   - 既存 ADR の原則と一時的にでも衝突する妥協（過渡期実装・in-memory で済ます選択など）。
   - 運用ポリシー（デプロイ窓・権限設計・秘密情報の扱い・cron 時刻の変更など）。
   - 代替案を明確に却下した判断（後から「なぜこうしたか」を問われる可能性があるもの）。
2. **ADR 化が不要な例**（記録しなくてよい）:
   - 命名の微修正、リファクタ、import 整理など再現性の低い・可逆な小変更。
   - 既存 ADR の方針を**そのまま**適用した実装（新規判断が存在しない）。
3. **作成手順**:
   - `docs/adr/` に `NNNN-kebab-case-title.md` を新規作成（番号は既存最大 + 1、ゼロ詰め 4 桁）。
   - フォーマットは `docs/adr/README.md` の MADR 準拠テンプレートに従う（frontmatter + Context / Decision / Consequences / Alternatives considered）。
   - `docs/adr/README.md` の Index 表へ 1 行追記。
   - 既存 ADR を置き換える場合は旧 ADR の `status` を `superseded` に変え `superseded-by` を埋める。削除はしない。
4. **過渡期の妥協も必ず記録**: 「暫定対応だから ADR 不要」と判断しない。過渡期であることを `status: accepted` + Consequences / Operational implications で明示し、移行条件を書く。
5. **PR 本文との関係**: PR 本文「変更点」「影響範囲」に `docs/adr/NNNN-*.md` へのリンクを添える。PR 本文は一時的、ADR は永続。

