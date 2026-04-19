# AGENTS.md

Summit（個人開発の Discord Bot。固定 4 名の「桃鉄1年勝負」出欠自動化）で AI エージェントが作業する際の **作業手順 / SSoT / 禁止領域 / 既知の落とし穴** の本体です。Codex / Claude Code / Copilot Coding Agent 共通参照。常時ルールの要約は `.github/copilot-instructions.md`、業務仕様の正典は `requirements/base.md`。

## まず確認（30秒）
1. 業務仕様は `requirements/base.md`（§1〜§16）
2. TS 実装規約は `.github/instructions/runtime.instructions.md`
3. 作業手順・禁止領域は本書

## 読了順序
1. `requirements/base.md`（業務仕様・正典）
2. `AGENTS.md`（本書）
3. `.github/instructions/runtime.instructions.md`（TS/Node 実装ルール）
4. 必要に応じて `README.md`（入口・ローカル手順）

Copilot Coding Agent では `.github/copilot-instructions.md` は常時注入されるが、Codex / Claude Code を含む共通運用のため、初回は内容差分を一読すること。疑問が残ったら正典（`requirements/base.md`）に戻る。

## SSoT（Single Source of Truth）
同一ルールの詳細定義は 1 箇所に置く。本書には「作業判断に必要な要約」と「参照先」のみを書く。

| 領域 | 正典 | 備考 |
|---|---|---|
| 業務仕様（締切・週キー・順延・参加条件・状態・custom_id 形式） | `requirements/base.md` | §1〜§16 |
| TS/Node 実装ルール | `.github/instructions/runtime.instructions.md` | applyTo: `{src,tests}/**/*.ts` |
| 常時ルール要約 | `.github/copilot-instructions.md` | Copilot Code Review は先頭 4,000 字のみ読む前提 |
| アプリ env 型 | `src/env.ts`（zod v4 スキーマ） | 一覧は `requirements/base.md` §10。`DIRECT_URL` は含めない（§13.3 の例は「必要 env 一覧」の例示） |
| migration 接続設定 | `drizzle.config.ts` | `DIRECT_URL` はここでのみ参照 |
| DB schema 定義 | `src/db/schema.ts`（または `src/db/schema/`） | 生成 SQL の正本は `drizzle/` |
| 時刻計算 | `src/time/` | JST・ISO week・締切・`POSTPONE_DEADLINE` 解釈 |
| 入口・ローカル手順 | `README.md` | 詳細仕様は `requirements/base.md` |

## 検証順序（PR 前に必ず実行）
```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build

# schema / drizzle / env に触れたら追加
pnpm db:check
```
原則として全部通してから提出する。既知のベースライン失敗がある場合は、再現手順・非起因である根拠・自分の変更範囲での検証結果を PR 本文に明記すること。

## 仮定プロトコル（推測禁止を現実化）
1. 仕様に明記 → 従う。
2. 明記なし・**可逆で小さい** 技術判断 → 進めて PR 本文の「仮定」「要確認事項」に明記。
3. 業務仕様に関わる判断（締切・週キー・順延ルール・参加条件・状態・custom_id 形式）で明記なし → 実装せず `// TODO(ai): spec clarification needed - <issue>` を残し、PR の「要確認事項」に書いて質問。
4. どの場合でも **本番破壊的操作 / デプロイ禁止窓違反 / 秘匿値露出 / 単一インスタンス前提の逸脱** は仮定で進めるな。

## 禁止領域（違反即リジェクト）
- **単一インスタンス逸脱**: Fly app を 2 instance 以上に scale しない。ローカルでも同一 Bot を二重起動しない。`node-cron` を起動時に多重登録しない。cron / reminder は DB 状態を正として 1 系統だけ動かす。
- **secrets 実値の混入**: `.env*`、token、`DATABASE_URL`、`DIRECT_URL`、`HEALTHCHECK_PING_URL` の実値をコード・fixture・ログ・PR 本文に載せない。commit 可能なのは `.env.example` の雛形のみ。
- **本番 DB 破壊**: 本番への `DROP` / `TRUNCATE` / 手動 `UPDATE` / 手動 `INSERT`、`fly ssh` 経由の生 SQL 実行、対話シェルでの破壊操作。
- **drizzle-kit push** の使用（必ず `generate` + `migrate`）。
- **secrets 不可逆変更**: `fly secrets unset` や既存 secrets の上書き。
- **デプロイ禁止窓**（金 17:30〜土 01:00 JST）での deploy / restart / schema 変更。
- `require()` による CommonJS 混入（ESM 固定）。
- `mise` が管理する Node / pnpm の版をローカルでずらす。
- `requirements/base.md` の用語変更や勝手な新語追加。

## PR テンプレート（本文に含める）
- **変更点**: 何を変えたか（機能・ファイル単位で簡潔に）
- **仮定**: 実装時に置いた仮定（無ければ「なし」）
- **要確認事項**: 仕様未確定 / `TODO(ai)` の論点（無ければ「なし」）
- **影響範囲**: 触った機能・DB・cron・Discord 側の副作用
- **テスト**: 追加/更新したテスト、手動確認
- **運用影響**: migration / env / `commands:sync` / deploy window
- **リスク**: 破壊的変更の有無

## 既知の落とし穴（踏まれやすい順）
1. **ボタン同時押下レース**: 固定 4 名でも押下順序は決まらない。DB 側の条件付き `UPDATE ... WHERE status = ...` と unique 制約（`responses` の `(sessionId, memberId)`）で競合を吸収する。
2. **deferUpdate 3 秒制約**: Interaction 受信後 3 秒以内に `deferUpdate()` を呼ばないと失敗。入口で即 defer → DB 更新 → メッセージ再描画。
3. **custom_id 信頼と検証省略**: `custom_id` を直接信用するな。`guildId` / `channelId` / `user.id ∈ MEMBER_USER_IDS` / `custom_id`（zod parse）/ session を検証してから状態変更。
4. **DB が正本**: Discord message は表示層。メッセージ再描画（`interaction.message.edit(...)`）失敗で DB を巻き戻すな。再描画は常に DB の Session + Response から組み立てる。
5. **cron 多重登録 / in-memory 依存**: cron は起動ごとに一度だけ登録。毎 tick DB から締切・リマインドを再計算。再起動後も回復でき、同一 tick の重複実行でも結果が変わらないよう冪等にする。
6. **Neon + postgres.js**: pooler 互換のため `postgres(connectionString, { prepare: false })` を忘れない。
7. **DIRECT_URL と DATABASE_URL の混同**: `DATABASE_URL` はアプリ用 (pooled)、`DIRECT_URL` は migration 用 (unpooled)。drizzle-kit は `DIRECT_URL` を使う。アプリ `env` に `DIRECT_URL` を含めない。
8. **drizzle-kit push 禁止**: 本番スキーマの意図せぬ変更源。必ず `generate` で SQL を作成し、レビュー後 `migrate` で適用。
9. **ISO week の年跨ぎ**: 金・土が年を跨ぐと ISO year が変わる。`date-fns/getISOWeek` と `getISOWeekYear` を併用し、`YYYY-Www` を自作しない。
10. **POSTPONE_DEADLINE="24:00" の解釈**: 「候補日翌日 00:00 JST」のみ。`25:00` など 24 超え表記は受け入れない。
11. **guild-scoped slash command**: コマンド登録は `DISCORD_GUILD_ID` 単位。global 登録は反映まで最大 1 時間かかる。`commands:sync` の guild 指定を確認。
12. **HEALTHCHECK_PING_URL 未設定時は ping 無効**（no-op）。未設定で起動を止めるな。設定時のみ cron 成功後に ping。
