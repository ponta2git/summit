# AGENTS.md

Summit（個人開発 Discord Bot / 固定 4 名の桃鉄 1 年勝負 出欠自動化）で AI エージェント（Codex / Claude Code / Copilot）が作業するときの**入口と手順書**。

## Doc taxonomy（この repo のドキュメント分業）

| ファイル | 役割 | ここにしか書かないもの |
|---|---|---|
| `requirements/base.md` | 業務仕様 SSoT | 状態名 / 締切 / 順延 / 週キー等の仕様用語 |
| `.github/copilot-instructions.md` | 常時ルール**要約**（即死ルールのみ） | 箇条 10 項目で完結 |
| **`AGENTS.md`（本書）** | **タスク入口 / 手順 / protocol / footgun** | 逆引き・decision tree・落とし穴 |
| `.github/instructions/*.md` | ドメイン別実装規約（`applyTo` 適用） | time / interaction / db / runtime / secrets 詳細 |
| `docs/adr/` | 判断根拠（Why）。索引 `docs/adr/README.md` | 意思決定の歴史・代替案却下 |
| `docs/operations/` | 運用 runbook（How）。入口 `docs/operations/README.md` | 障害 SOP / migration / backup / secrets rotation / time skew |
| `src/config.ts` / `src/env.ts` / `src/db/schema.ts` / `src/time/` | **実行されるリテラル値の唯一 SSoT**（ADR-0022） | cron 式 / HH:MM / 閾値 / 状態名 / 列名 |

**原則**: 要約は copilot-instructions、詳細は AGENTS.md、規約は instructions、リテラルはコード。重複記述は drift 源（ADR-0022）。

## タスク → 最初に開くファイル

| タスク | 最初に開く |
|---|---|
| 業務仕様を確認したい | `requirements/base.md` |
| 新しい handler / scheduler / workflow を書く | `.github/instructions/runtime.instructions.md` + `src/appContext.ts` |
| 時刻・週キー・締切に触る | `.github/instructions/time-review.instructions.md` + `src/time/` |
| Interaction / Discord 送信に触る | `.github/instructions/interaction-review.instructions.md` |
| DB schema / migration | momo-db リポジトリ（`../momo-db/src/schema.ts` / `drizzle/`）＋ `.github/instructions/db-review.instructions.md` |
| env / secrets / ログ | `.github/instructions/secrets-review.instructions.md` + `src/env.ts` |
| ADR を読みたい（判断根拠を探す） | `docs/adr/README.md#how-to-find-the-right-adr` |
| ADR を書く / 更新する | 本書「ADR プロトコル」 + `docs/adr/README.md#adr-format-madr` |
| ADR の supersede 状況を確認 | `docs/adr/README.md#status-lifecycle` |
| 障害・復旧・migration・secrets rotation の手順 | `docs/operations/README.md` |
| 設計判断で迷った | 本書「仮定プロトコル」 |

## Pre-code red-flag checklist

コード変更前に以下を自問。Yes/No だけで良い。詳細は pointer 先。

1. **JST 固定か？** `new Date()` を `src/time/` 外で使っていないか。→ time-review
2. **env は `src/env.ts` 経由か？** `process.env.*` 直接参照していないか。→ secrets-review
3. **依存は `ctx.ports.*` / `ctx.clock` か？** repositories / `systemClock` 直 import していないか。→ ADR-0018
4. **Interaction は defer 先行か？** 検証より前に `deferUpdate()` / `deferReply()` しているか。→ interaction-review
5. **今、deploy 禁止窓か？** 金 17:30〜土 01:00 JST は deploy / restart / schema 変更しない。
6. **秘匿値に触れるか？** token / 接続文字列 / ping URL を code / fixture / log / PR に出さない。→ secrets-review
7. **リテラル値を ADR / コメントに書き写していないか？** `src/config.ts` 等への pointer に留める（ADR-0022）。

## 禁止領域（違反即リジェクト）

- **単一インスタンス逸脱**: Fly scale 増 / ローカル二重起動 / `node-cron` 多重登録。
- **secrets 実値の混入**: `.env*` 実値 / token / 接続文字列 / ping URL をコード・fixture・ログ・PR・コミットに載せる（commit 可は `.env.example` のみ）。
- **本番 DB 破壊**: `DROP` / `TRUNCATE` / 手動 `UPDATE` / `INSERT` / `fly ssh` 生 SQL。
- **drizzle-kit push**: migration は `generate` + `migrate` のみ。
- **secrets 不可逆変更**: `fly secrets unset` / 既存上書きの ad-hoc 実行。
- **デプロイ禁止窓違反**: 金 17:30〜土 01:00 JST の deploy / restart / schema 変更。
- **CommonJS 混入**: `require()` 禁止（ESM 固定）。
- **mise 管理外の Node/pnpm 版**でローカル実行。
- **`requirements/base.md` の用語変更・新語追加**。

## 仮定プロトコル

```
仕様に明記あり? ─ Yes → PROCEED（従う）
        │
        No
        │
        ├─ 本番破壊 / 禁止窓違反 / 秘匿露出 / 単一インスタンス逸脱? ─ Yes → STOP（実装しない）
        │
        ├─ 業務仕様に関わる判断?
        │    （締切 / 週キー / 順延 / 参加条件 / 状態 / custom_id 形式）
        │       Yes → ADD `// todo(ai): spec clarification needed - <issue>` + ASK（PR 要確認事項に質問）
        │
        └─ 可逆で小さい技術判断 → PROCEED + 仮定を PR 本文に明記
```

## ADR プロトコル

### Step 1: 必要判定

**書く**: 以下いずれか該当
- 業務仕様に影響する決定（締切 / 週キー / 順延 / 参加条件 / 状態 / `custom_id` 形式 / 経路の扱い）
- アーキテクチャ層の選択（ライブラリ / 永続化 / スケジューラ / 並行制御）
- 既存 ADR の原則と一時でも衝突する妥協（過渡期実装含む）
- 運用ポリシー（デプロイ窓 / 権限 / 秘密情報 / cron 時刻の変更）
- 代替案を明確に却下した判断

**書かない**: 命名微修正 / リファクタ / import 整理 / 既存 ADR をそのまま適用した実装。

### Step 2: 手順

1. `docs/adr/NNNN-kebab-case-title.md` を作成（番号は最大 +1、ゼロ詰め 4 桁）。
2. `docs/adr/README.md` のテンプレート（MADR）に従い frontmatter + `TL;DR` + `Context` / `Decision` / `Consequences` / `Alternatives considered` を書く。該当すれば `Re-evaluation triggers` と `Links` も。
3. **frontmatter 必須**: `adr` / `title` / `status` / `date` / `tags` / `supersedes` / `superseded-by`。`id:` や quoted 番号は使わない。
4. **TL;DR は 1〜2 文必須**: Context の要約ではなく「何を決めたか」を書く。
5. **リテラル値を書き写さない**: cron 式・HH:MM・閾値・状態名は `src/config.ts` 等の定数名を pointer 参照（ADR-0022）。例外: Context / Alternatives の歴史的経緯記述は許容。
6. **代替案却下時は `Re-evaluation triggers` 推奨**: 将来条件を満たしたら再検討する旨。
7. **tags は README の Topic map と整合**: `runtime` / `db` / `discord` / `ops` / `docs` / `time` / `testing` / `dev-tools` から選ぶ。新 tag を追加するなら README も同時更新。
8. `docs/adr/README.md` の **Index に 1 行追記**。必要に応じ Topic map / Supersede chain も更新。
9. 置き換え時: 旧 ADR を `status: superseded` にし `superseded-by` を埋める（本文は改変しない）。Supersede chain に追記。
10. 過渡期の妥協も記録（移行条件を Consequences に書く）。
11. PR 本文「変更点」「影響範囲」に該当 ADR へのリンク。
12. **トポロジを変える ADR**（feature 追加 / infra 再編 / 依存方向変更）なら `docs/adr/README.md#architecture-snapshot` も同 PR 内で更新する。

## 検証順序（PR 前に必ず）

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

ベースライン失敗時は再現手順・非起因の根拠・自分の変更範囲での検証結果を PR 本文に明記。

## PR テンプレート

- **変更点**: 何を変えたか
- **仮定**: 実装時に置いた仮定（無ければ「なし」）
- **要確認事項**: 仕様未確定 / `todo(ai)`（無ければ「なし」）
- **影響範囲**: 機能・DB・cron・Discord 副作用・関連 ADR リンク
- **テスト**: 追加/更新したテスト、手動確認
- **運用影響**: migration / env / `commands:sync` / deploy window
- **リスク**: 破壊的変更の有無

コミットは Conventional Commits（英語）。PR 本文は日本語。

## 開発中の DB 操作（ローカル限定）

週の流れをやり直すとき **`docker exec` / `psql` で手 TRUNCATE しない**。`pnpm db:reset` を使う。

- `pnpm db:reset` — `sessions` / `responses` を TRUNCATE（`members` 保持）
- `pnpm db:reset --all` — `members` も TRUNCATE（この後 `pnpm db:seed` 必須）

実体は `scripts/dev/reset.ts`。`DATABASE_URL` host が `localhost` / `127.0.0.1` / `::1` / `postgres` 以外なら即 throw。「データを消して」「Duplicate ask skipped を解消」等の依頼があれば本コマンドを使う。

## 既知の落とし穴（ドメイン別）

落とし穴は primary domain に一度だけ書く。関連 domain は `[tag]` で示す。

### time

1. **ISO week 年跨ぎ**: `getISOWeek` + `getISOWeekYear` 併用（自作禁止）。12/31 金 → 1/1 土で ISO year が変わる。
2. **`POSTPONE_DEADLINE="24:00"`** `[discord]`: 「候補日翌日 00:00 JST」のみ。24 超え表記は parse 段階で弾く。

### db

3. **`drizzle-kit push` 禁止**: `generate` で SQL 出力 → レビュー → `migrate`。
4. **DIRECT_URL と DATABASE_URL の混同**: `DATABASE_URL` はアプリ（pooled）、`DIRECT_URL` は momo-db の migration（unpooled）。アプリ env に `DIRECT_URL` 含めない。
5. **Neon + postgres.js**: pooler 互換で `postgres(url, { prepare: false })` 明示。
6. **ボタン同時押下レース** `[discord]`: DB の条件付き `UPDATE ... WHERE status = ...` と `(sessionId, memberId)` unique で吸収。
7. **DB が正本** `[discord]`: `message.edit` 失敗で DB を巻き戻すな。再描画は常に DB の Session+Response から組み立てる。

### discord

8. **deferUpdate 3 秒制約**: Component は `deferUpdate()`、Slash は `deferReply()/reply()`。defer を検証より先に。
9. **custom_id 不信**: 直接信用せず `guildId` / `channelId` / `user.id` / `custom_id`（zod）/ session を検証してから状態変更。
10. **guild-scoped slash sync**: global 登録は伝播最大 1 時間。`commands:sync` の guild 指定を確認。

### ops

11. **cron 多重登録 / in-memory 依存**: cron は起動時 1 回のみ。毎 tick DB 再計算。起動時に非終端 Session を再読込。同一 tick 重複実行で結果が変わらないこと。
12. **`HEALTHCHECK_PING_URL` 未設定時は ping 無効**（no-op）。未設定で起動停止するな。

### testing

13. **AppContext 経由の依存注入**: 新規 handler/scheduler/workflow は repositories を直接 import せず `ctx.ports.*` / `ctx.clock` を使う。テストは `createTestAppContext` で Fake ports（`vi.mock` を新規追加しない）。根拠 ADR-0018。
