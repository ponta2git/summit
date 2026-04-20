# AGENTS.md

Summit（個人開発の Discord Bot。固定 4 名の桃鉄 1 年勝負 出欠自動化）で AI が作業する際の **手順 / SSoT / 禁止領域 / プロトコル / 落とし穴** の本体。Codex / Claude Code / Copilot Coding Agent 共通。常時ルール要約は `.github/copilot-instructions.md`、業務仕様正典は `requirements/base.md`。

## 読了順序
1. `requirements/base.md`（業務仕様・正典）
2. `AGENTS.md`（本書）
3. `.github/instructions/runtime.instructions.md`（TS/Node 実装ルール）
4. 必要時 `README.md` / `docs/adr/`（索引は `docs/adr/README.md`）

## SSoT（情報の正典マップ）
同一ルールの詳細は 1 箇所にのみ置き、他は参照で繋ぐ（ADR-0022）。

| 領域 | 正典 | 備考 |
|---|---|---|
| 業務仕様 | `requirements/base.md` | §1〜§10 |
| TS/Node 実装ルール | `.github/instructions/runtime.instructions.md` | applyTo 適用 |
| 常時ルール要約 | `.github/copilot-instructions.md` | Copilot Code Review は先頭 4,000 字前提 |
| アプリ env 型 | `src/env.ts`（zod v4） | 実値は Fly secrets。`DIRECT_URL` は含めない |
| migration 接続 | `drizzle.config.ts` | `DIRECT_URL` はここだけ |
| DB schema | `src/db/schema.ts` | 生成 SQL の正本は `drizzle/` |
| 時刻計算 | `src/time/` | JST / ISO week / 締切 / `POSTPONE_DEADLINE` |
| runtime tunables（cron 式・時刻閾値・slot・reminder lead） | `src/config.ts` | ADR/コメントに値を書き写さない |
| 依存合成 | `src/composition.ts`（`AppContext`） | production は `src/index.ts` の `createAppContext()`、テストは `tests/testing/ports.ts` の `createTestAppContext`。根拠 ADR-0018 |
| 判断根拠（Why） | `docs/adr/` | 索引 `docs/adr/README.md` |
| 情報の正典マップ自体の運用 | ADR-0022 | SSoT taxonomy |

## 検証順序（PR 前に必ず）
```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
pnpm db:check    # schema/drizzle/env に触れたら追加
```
ベースライン失敗がある場合は再現手順・非起因の根拠・自分の変更範囲での検証結果を PR 本文に明記。

## 仮定プロトコル
1. 仕様に明記 → 従う。
2. 明記なし + **可逆で小さい** 技術判断 → 進めて PR 本文「仮定」「要確認事項」に明記。
3. 業務仕様に関わる判断（締切 / 週キー / 順延 / 参加条件 / 状態 / `custom_id` 形式）で明記なし → 実装せず `// todo(ai): spec clarification needed - <issue>` を残し PR「要確認事項」で質問。
4. 本番破壊 / デプロイ禁止窓違反 / 秘匿値露出 / 単一インスタンス逸脱は仮定で進めない。

## ADR 作成プロトコル
**設計判断を行ったら、その PR 内で `docs/adr/` に ADR を新規作成または更新する**。PR 本文は一時的、ADR は永続。

**ADR 化が必要**（いずれか該当）:
- 業務仕様に影響する決定（締切 / 週キー / 順延 / 参加条件 / 状態 / `custom_id` 形式 / 経路の扱い）
- アーキテクチャ層の選択（ライブラリ採用 / 永続化 / スケジューラ / 並行制御）
- 既存 ADR の原則と一時でも衝突する妥協（過渡期実装含む）
- 運用ポリシー（デプロイ窓 / 権限 / 秘密情報 / cron 時刻の変更）
- 明確に代替案を却下した判断

**不要**: 命名微修正・リファクタ・import 整理、既存 ADR をそのまま適用した実装。

**手順**:
1. `docs/adr/NNNN-kebab-case-title.md` を作成（番号は最大 +1、ゼロ詰め 4 桁）。
2. `docs/adr/README.md` のテンプレート（MADR）に従い Context / Decision / Consequences / Alternatives considered を書く。実行される値（cron 式・HH:MM 等）は Decision/Consequences に書き写さず `src/config.ts` 等へのポインタにする（ADR-0022）。
3. `docs/adr/README.md` の Index に 1 行追記。
4. 置き換え時は旧 ADR を `status: superseded` にし `superseded-by` を埋める（削除しない）。
5. 過渡期の妥協も記録（「暫定だから不要」と判断しない）。移行条件を Consequences に書く。
6. PR 本文の「変更点」「影響範囲」に該当 ADR へのリンクを添える。

## 禁止領域（違反即リジェクト）
- **単一インスタンス逸脱**: Fly scale 増・ローカル二重起動・`node-cron` 多重登録。
- **secrets 実値の混入**: `.env*` 実値 / token / 接続文字列 / ping URL をコード・fixture・ログ・PR・コミットに載せる。commit 可は `.env.example` のみ。
- **本番 DB 破壊**: `DROP` / `TRUNCATE` / 手動 `UPDATE` / `INSERT`、`fly ssh` 生 SQL。
- **drizzle-kit push** 使用（必ず `generate` + `migrate`）。
- **secrets 不可逆変更**: `fly secrets unset` / 既存上書きの ad-hoc 実行。
- **デプロイ禁止窓違反**: 金 17:30〜土 01:00 JST の deploy / restart / schema 変更。
- `require()` による CommonJS 混入（ESM 固定）。
- `mise` 管理下の Node/pnpm 版をローカルでずらす。
- `requirements/base.md` の用語変更・勝手な新語追加。

## 開発中の DB 操作（ローカル限定）
週の流れをやり直すときは **`docker exec` / `psql` で手 TRUNCATE しない**。`pnpm db:reset` を使う。
- `pnpm db:reset` — `sessions` / `responses` を TRUNCATE（`members` 保持）。
- `pnpm db:reset --all` — `members` も TRUNCATE（この後 `pnpm db:seed` 必須）。

実体は `src/db/devReset.ts`。`DATABASE_URL` host が `localhost` / `127.0.0.1` / `::1` / `postgres` 以外なら即 throw。ユーザから「データを消して」「Duplicate ask skipped を解消」等の依頼があれば本コマンドを使うこと。

## PR テンプレート
- **変更点**: 何を変えたか
- **仮定**: 実装時に置いた仮定（無ければ「なし」）
- **要確認事項**: 仕様未確定 / `todo(ai)`（無ければ「なし」）
- **影響範囲**: 機能・DB・cron・Discord 副作用・関連 ADR リンク
- **テスト**: 追加/更新したテスト、手動確認
- **運用影響**: migration / env / `commands:sync` / deploy window
- **リスク**: 破壊的変更の有無

## 既知の落とし穴
1. **ボタン同時押下レース**: DB の条件付き `UPDATE ... WHERE status = ...` と `(sessionId, memberId)` unique で吸収。
2. **deferUpdate 3 秒制約**: Component は `deferUpdate()`、Slash は `deferReply()/reply()`。defer を検証より先に。
3. **custom_id 不信**: 直接信用せず `guildId`/`channelId`/`user.id`/`custom_id`（zod）/session を検証してから状態変更。
4. **DB が正本**: `message.edit` 失敗で DB を巻き戻すな。再描画は常に DB の Session+Response から組み立てる。
5. **cron 多重登録 / in-memory 依存**: cron は起動時 1 回のみ。毎 tick DB 再計算。起動時に非終端 Session を再読込。同一 tick 重複実行で結果が変わらないこと。
6. **Neon + postgres.js**: pooler 互換で `postgres(url, { prepare: false })` 明示。
7. **DIRECT_URL と DATABASE_URL の混同**: `DATABASE_URL` はアプリ（pooled）、`DIRECT_URL` は migration（unpooled）。アプリ env に `DIRECT_URL` 含めない。
8. **drizzle-kit push 禁止**: `generate` で SQL 出力 → レビュー → `migrate`。
9. **ISO week 年跨ぎ**: `getISOWeek` + `getISOWeekYear` 併用（自作禁止）。
10. **`POSTPONE_DEADLINE="24:00"`**: 「候補日翌日 00:00 JST」のみ。24 超え表記を parse 段階で弾く。
11. **guild-scoped slash sync**: global 登録は伝播最大 1 時間。`commands:sync` の guild 指定を確認。
12. **`HEALTHCHECK_PING_URL` 未設定時は ping 無効**（no-op）。未設定で起動停止するな。
13. **AppContext 経由の依存注入**: 新規 handler/scheduler/workflow は repositories を直接 import せず `ctx.ports.*`/`ctx.clock` を使う。テストは `createTestAppContext` で Fake ports（`vi.mock` を新規追加しない）。ADR-0018。
