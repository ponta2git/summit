# Summit

Summit は、固定 4 名で毎週金曜深夜に遊ぶ「桃鉄1年勝負」の出欠確認を自動化する Discord Bot です。金曜 08:00 ごろに募集を出し、21:30 の締切で開催可否を判定し、欠席や未回答があれば土曜への順延確認まで扱います。

業務仕様の正典は [`requirements/base.md`](./requirements/base.md) です。本 README は **人間向けのセットアップ・運用・技術選定の案内**であり、業務仕様との矛盾が生じた場合は常に `requirements/base.md` が優先されます。

---

## 現在の実装範囲（2026-04 時点）

- `/ask` で固定チャンネルに募集メッセージ（本文 + 5 ボタン）を送信
- 毎週金曜 08:00 JST の cron で同じ募集メッセージを自動送信
- ボタン押下は暫定で ephemeral 応答（受付本実装は未着手）
- `/cancel_week` で今週分の非終端 Session を確認ダイアログ経由で `SKIPPED` に収束

---

## 技術スタック（確定）

| 層 | 採用技術 | 補足 |
|---|---|---|
| 言語 | **TypeScript**（Node.js **v24 LTS "Krypton"**） | `.mise.toml` と `package.json#engines` で固定 |
| パッケージマネージャ | **pnpm v10** | `package.json#packageManager` で版数固定 |
| Node/pnpm 管理 | **mise**（`.mise.toml` が正本） | asdf / nvm / fnm は補助的に互換 |
| Discord ライブラリ | **discord.js v14** | Gateway 常駐 |
| ホスティング | **Fly.io** | 常時起動・**単一インスタンス** |
| DB | **Neon (PostgreSQL 16)** | 無料枠 |
| ORM | **Drizzle ORM（v0.45 系）** | SQL 透明性重視 |
| PG ドライバ | **postgres.js** | Drizzle 公式推奨。Neon pooler と相性良好 |
| マイグレーション | **drizzle-kit**（`generate` + `migrate`。`push` は使わない） | CI で `check` による履歴整合検証 |
| スケジューラ | **node-cron v4** | 毎分ポーリングで締切・リマインドを **DB 状態から再計算** |
| ロギング | **pino**（構造化 JSON、stdout → `fly logs`） | 外部ログ SaaS は不採用 |
| バリデーション | **zod v4**（env / interaction payload） | DB 連携は `drizzle-zod >= 0.8.0` |
| テスト | Vitest など TypeScript 対応ランナー + DB 統合 | E2E は実施しない |
| 設定管理 | 環境変数（本番: Fly secrets / ローカル: `.env.local`） | `.env.example` のみコミット |

**月額費用の目安**: 約 $2〜3（300〜450円）。

---

## 前提

- 対応 OS: macOS / Linux（Windows 未検証）
- 必要ツール:
  - [`mise`](https://mise.jdx.dev/)
  - Node.js 24 LTS（`mise install` で入る）
  - pnpm v10（同上）
  - Docker（ローカル DB 用）

`mise` を正本として Node / pnpm の版をそろえ、DB は Docker で起動します。手元の Node や別パッケージマネージャに合わせて読み替えないでください。

---

## 初回セットアップ

1. Discord Developer Portal で Application と Bot を作成し、Bot Token を取得する。
2. Bot を運用 Guild に招待する（必要な scopes / intents / permissions は「Discord 権限設定」を参照）。
3. Guild ID / 投稿先 Channel ID / 固定 4 名の User ID を控える（開発者モードで右クリック → ID コピー）。
4. リポジトリを clone する。
5. `mise install` で Node / pnpm をそろえる。
6. `.env.local` を作る:
   ```bash
   cp .env.example .env.local
   ```
   Discord / DB / 運用設定の値を埋める。ローカルでは `DATABASE_URL` と `DIRECT_URL` は同一値で構わない。
7. 依存インストール + DB 起動 + migration + seed を一括で実行:
   ```bash
   pnpm run setup   # pnpm install -> db:up -> db:migrate -> db:seed
   ```
8. Discord slash command を同期（guild-scoped）:
   ```bash
   pnpm commands:sync
   ```
9. 開発起動:
   ```bash
   pnpm dev
   ```

初回以降は通常 `pnpm dev` と、必要に応じた `pnpm test` / `pnpm typecheck` / `pnpm lint` で足ります。

---

## 主要コマンド

```bash
pnpm dev            # 開発起動（tsx watch）
pnpm test           # テスト
pnpm typecheck      # TypeScript 型検査
pnpm lint           # Lint
pnpm build          # 本番ビルド
pnpm db:up          # Docker で DB 起動
pnpm db:down        # Docker の DB 停止
pnpm db:generate    # Drizzle migration SQL 生成
pnpm db:migrate     # migration 適用
pnpm db:check       # Drizzle の履歴整合検証
pnpm db:seed        # 開発用 seed 投入
pnpm db:reset       # 開発用: sessions / responses を TRUNCATE（localhost 限定。`--all` で members も削除）
pnpm commands:sync  # Discord slash commands を guild-scoped で同期
```

schema を変えたら `pnpm db:generate` → 生成 SQL をレビュー → `pnpm db:migrate` → `pnpm db:check` の順。`drizzle-kit push` は使いません。slash command の定義を変えたら `pnpm commands:sync` を忘れないでください。

---

## 検証ハーネス

静的チェックと運用ガードを CI / ローカルで再現可能な形にそろえています。

- ローカル推奨順序:
  ```bash
  pnpm typecheck
  pnpm lint
  pnpm test
  pnpm build
  pnpm db:check
  pnpm verify:forbidden
  pnpm verify:drift
  ```
- `pnpm run ci`: required チェックを直列実行（`typecheck / lint / test / build / db:check / verify:forbidden`）。
- `.github/instructions/`: 変更ファイル領域ごとのレビュー観点を AI に注入。
- `.github/PULL_REQUEST_TEMPLATE.md`: 仕様整合・運用安全チェックの記入テンプレート。

---

## 環境変数

アプリコードは `process.env` を直接読まず、`src/env.ts` で validate 済みの値を使う前提です。`.env*` や token / DB URL / ping URL の実値は絶対に commit しないでください（雛形の `.env.example` のみ可）。

| 名前 | 例 | 説明 |
|---|---|---|
| `DISCORD_TOKEN` | `xxx` | Bot トークン（Fly secrets 管理） |
| `DISCORD_GUILD_ID` | `12345...` | 運用 Discord サーバー（Guild）ID |
| `DISCORD_CHANNEL_ID` | `12345...` | 投稿先チャンネル ID |
| `MEMBER_USER_IDS` | `id1,id2,id3,id4` | 固定 4 名の User ID（カンマ区切り、4 件ちょうど） |
| `MEMBER_DISPLAY_NAMES` | `name1,name2,name3,name4` | 任意。指定時は `MEMBER_USER_IDS` と同順で `members.display_name` を起動時に上書き |
| `CANDIDATE_TIMES` | `22:00,22:30,23:00,23:30` | 開催候補時刻 |
| `ASK_TIME` | `08:00` | 自動送信時刻（金 / 土の当日） |
| `ANSWER_DEADLINE` | `21:30` | 回答締切 |
| `POSTPONE_DEADLINE` | `24:00` | 順延確認の回答期限。`"24:00"` は「候補日翌日 00:00 JST」を示す慣習表記として**唯一サポートする**。`25:00` 等は非対応 |
| `REMIND_BEFORE_MINUTES` | `15` | 開始前リマインド分数 |
| `DATABASE_URL` | `postgres://...-pooler.../neondb?sslmode=require` | Neon 接続文字列（**アプリ用・pooled**） |
| `DIRECT_URL` | `postgres://.../neondb?sslmode=require` | Neon 接続文字列（**migration 用・direct**。`drizzle.config.ts` のみで参照し、アプリコードから参照しない） |
| `TZ` | `Asia/Tokyo` | タイムゾーン固定 |
| `HEALTHCHECK_PING_URL` | `https://hc-ping.com/...` | 死活監視用 ping URL（healthchecks.io 等）。未設定なら ping は no-op |
| `DEV_SUPPRESS_MENTIONS` | `false` | 開発用 mention 抑止スイッチ。`true` で本文から `<@id>` を除去し Client に `allowedMentions: { parse: [] }` を付与。本番は未設定（= false）維持。詳細は [ADR-0011](./docs/adr/0011-dev-mention-suppression.md) |

### env 検証（zod v4 / 起動時 Fail Fast）

```ts
const Env = z.object({
  DISCORD_TOKEN: z.string().min(50),
  DISCORD_GUILD_ID: z.string().regex(/^\d{17,20}$/),
  DISCORD_CHANNEL_ID: z.string().regex(/^\d{17,20}$/),
  MEMBER_USER_IDS: z.string()
    .transform(s => s.split(',').map(x => x.trim()))
    .pipe(z.array(z.string().regex(/^\d{17,20}$/)).length(4)),  // 4件ちょうど
  DATABASE_URL: z.string().url(),
  TZ: z.literal('Asia/Tokyo'),
  // ... 他の時刻系
});
```

`DIRECT_URL` は **アプリ実行時 env には含めない**（`drizzle.config.ts` 専用）。parse 失敗時は stderr に人間可読な内容を出して `process.exit(1)` で停止します。

---

## Discord 権限設定

招待 URL 生成時に最小権限で作ります。漏れたら運用中に invalid になる可能性があります。

- **OAuth2 scopes**: `bot`, `applications.commands`
- **Gateway Intents**: `Guilds` のみ（`GuildMessages` / `MessageContent` / `GuildMembers` は**不要**）
- **Bot Permissions**: `View Channel` / `Send Messages` / `Embed Links`

Bot は Gateway 経由で interaction を受信するため、HTTP Interactions Endpoint の Ed25519 署名検証は不要です。

---

## ローカル開発環境

個人開発でも「clone → 5 分で動く」を最優先。SaaS 依存を排除し、オフラインでも開発継続できる構成です。

- リポジトリ直下の `compose.yaml` で PostgreSQL 16 をコンテナ起動（`pnpm db:up`）。
- ローカルでは `DATABASE_URL` と `DIRECT_URL` は同一値でよい（pooler は不要）。
- **Neon branch** はリリース前の動作確認用の補助（オフライン要件のため主系には使わない）。
- 時刻依存ロジックの手動検証には「疑似現在時刻を注入できる仕組み」を用意する（fake timers / 関数 DI / Clock オブジェクトなど）。

### 開発中の DB リセット

Bot の動作確認で週の流れ（ask → cancel → postpone 等）を何度もやり直したいとき、既存の Session が残っていると `Duplicate ask message skipped.` で新規投稿が止まります。やり直したいときは:

```bash
pnpm db:reset          # sessions / responses を TRUNCATE（members は残す）
pnpm db:reset --all    # members も含めて TRUNCATE（この後は pnpm db:seed が必要）
```

- **安全装置**: `DATABASE_URL` のホストが `localhost` / `127.0.0.1` / `::1` / `postgres` のいずれでもないときは即エラーで停止します（本番 Neon / Fly の URL では動作しません）。
- 実体は `scripts/dev/reset.ts`（`pnpm db:seed` と同じ流儀）。本番フローに混入しない実行経路のため `pnpm setup` / `pnpm ci` には含めていません。

### pnpm v10 の注意点

- **ライフサイクルスクリプトは既定で無効化**される（v10 から）。本プロジェクトでは `tsx` / `drizzle-kit` / `vitest` が依存する **`esbuild`** で postinstall が必要です。

```jsonc
{
  "pnpm": {
    "onlyBuiltDependencies": ["esbuild"]
  }
}
```

新しい依存を追加したあと `pnpm` スクリプトが失敗したら、まず `onlyBuiltDependencies` の漏れを疑ってください。

---

## CI/CD

個人開発の原則「ないと困るもの以外は自動化しない」。Staging 環境は作りません。

### PR / main push 時（CI）
- `actions/setup-node@v4` で Node 24 を準備、`pnpm/action-setup@v4` で pnpm を有効化、`pnpm install --frozen-lockfile`。
- `pnpm lint` / `pnpm typecheck` / `pnpm test`。
- **Drizzle 整合性検証**: `pnpm db:check`（migration 履歴の整合）を必須。`db:generate` を走らせて `drizzle/` に未コミット差分が出た場合は warning。

### main push 時（Deploy。CI パス前提）
- `superfly/flyctl-actions/setup-flyctl` → `flyctl deploy --remote-only`。
- deploy 直後に `pnpm commands:sync`（guild-scoped bulk overwrite）で slash command を同期。
- `FLY_API_TOKEN` は **app-scoped deploy token**（`fly tokens create deploy`）のみ使用。Personal Auth Token は CI に登録しない。漏洩時は即 revoke。

ブランチ運用は `main = 本番` + feature ブランチ PR → squash merge。Dependabot を週次で有効化（`pnpm audit` は**参考情報**扱い、CI の fail 条件にはしない）。

---

## デプロイ運用

- Fly.io、常時起動・**単一インスタンス**。`min_machines_running = 1` / auto_stop 無効。
- デプロイ戦略は `rolling`（単一インスタンスのため deploy 中に数十秒のダウン窓あり）。
- 本番 secrets は `fly secrets set KEY=...` で登録。Personal Auth Token ではなく app-scoped deploy token を使う。

### 初回セットアップ（本番）

1. **Neon**: プロジェクトを作成し、production branch の pooled 接続文字列（`DATABASE_URL`）と direct 接続文字列（`DIRECT_URL`）を控える。
2. **Discord**: Developer Portal で Application / Bot を作成し、token（`DISCORD_TOKEN`）と Application ID（`DISCORD_CLIENT_ID`）を控える。運用 Guild ID（`DISCORD_GUILD_ID`）、運用チャンネル ID（`DISCORD_CHANNEL_ID`）、メンバー user ID 4 名（`MEMBER_USER_IDS`）を収集。OAuth2 scopes は `bot` / `applications.commands`、Bot Permissions は `View Channel` / `Send Messages` / `Embed Links` のみで招待 URL を生成して Guild へ追加。
3. **Fly.io**:
   ```bash
   fly auth login
   fly launch --no-deploy              # fly.toml 雛形を生成
   # fly.toml を編集: [deploy] release_command = "pnpm drizzle-kit migrate"
   #                  min_machines_running = 1, auto_stop_machines = false
   #                  [[processes]] app = "node dist/index.js"
   fly scale count 1                   # 単一インスタンス固定
   fly secrets set \
     DISCORD_TOKEN=... \
     DISCORD_CLIENT_ID=... \
     DISCORD_GUILD_ID=... \
     DISCORD_CHANNEL_ID=... \
     MEMBER_USER_IDS=... \
     DATABASE_URL=... \
     DIRECT_URL=... \
     HEALTHCHECK_PING_URL=...          # 任意
   fly tokens create deploy            # app-scoped deploy token → GitHub secrets の FLY_API_TOKEN に登録
   fly deploy --remote-only            # 初回 deploy。release_command で migrate 実行
   pnpm commands:sync                  # guild-scoped で slash command を同期
   ```
4. **healthchecks.io**（任意）: check を作成し、ping URL を `HEALTHCHECK_PING_URL` に設定。通知先（メール / Discord Webhook）を登録。

### デプロイ禁止窓

**金 17:30 〜 翌土 01:00 JST はアプリ deploy・restart・schema 変更を行わない**。開催当日の募集・判定と重なるためです。デプロイワークフロー側で時刻ガードを入れる実装も推奨。

本番 deploy 前には最低でも `pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm build` を通してください。単一インスタンス前提のため、復旧やロールバックも「二重起動させない」ことを優先して実施してください。

### マイグレーション運用

- 開発: スキーマ編集 → `pnpm db:generate`（SQL 差分を `drizzle/` 配下に出力、Git commit）→ `pnpm db:migrate` でローカル適用。
- 本番: Fly.io の `release_command = "pnpm drizzle-kit migrate"` で自動適用。**`DIRECT_URL` を使用**。失敗したら新バージョンは起動しない。
- `drizzle-kit push` は本番では**使用禁止**。必ず生成済み SQL を経由。
- アプリ実行時の接続は `DATABASE_URL`（pooled）。`DIRECT_URL` は **アプリコードから参照禁止**（`drizzle.config.ts` 以外での参照をレビューまたは静的チェックで拒否）。

### メンバー追加・削除

- `MEMBER_USER_IDS` 変更は Fly secrets 更新 → 再デプロイが必要（ダウンが生じる）。
- 変更はデプロイ禁止窓外で実施してください。

---

## 死活監視

- 起動完了時に `HEALTHCHECK_PING_URL` へ best-effort GET を投げる（boot ping）。タイムアウト値は `src/config.ts` の `HEALTHCHECK_PING_TIMEOUT_MS` を参照。
- node-cron の毎分 tick 内でも同 URL へ short-timeout GET を投げる（tick ping）。cron 式は `src/config.ts` の `HEALTHCHECK_PING_INTERVAL_CRON` を参照。
- 監視サービス側で「数分間 ping が来なければ通知」を設定し、Bot プロセス死亡・Fly.io 障害・Neon 断絶のいずれでも通知が飛ぶ状態にする。
- 通知チャネルはメール / Discord Webhook のいずれか。未設定（`HEALTHCHECK_PING_URL` なし）時は ping 自体を no-op にする。

---

## ログ運用

- すべての状態遷移・Discord API 呼び出し・エラーを構造化 JSON で stdout に出力。`fly logs` で参照。
- 外部ログ集約サービス（Axiom / Logtail 等）は**採用しない**（月間ログ量は最大数十 MB 程度で Fly のストリームログで十分）。
- 過去ログを残したい場合は `fly logs | tee` で手動保存。
- トークン・接続文字列・`Authorization` ヘッダ・interaction payload 全量などは pino の `redact` で除去する。

---

## 依存関係の脆弱性管理

- **Dependabot** を有効化し、週次で依存更新 PR を受け取る。
- `pnpm audit` / `npm audit` は CI で**情報表示のみ**（fail 条件にはしない）。
- 新規依存の追加は手動レビュー（README / スター数 / メンテナンス状況）で十分。

---

## テスト方針

- **単体**: 判定ロジック（集計、開始時刻算出、週キー算出、順延可否、時刻パーサ）を純粋関数として分離しカバー。
- **統合**: Drizzle リポジトリ層 + interaction handler（時間依存は fake timer、DB は `services: postgres` / testcontainers / Neon branch のいずれか）。
- **E2E は実施しない**（Discord API mock の維持コストが高く ROI が低い。代わりに純粋関数の単体テストを厚くする）。

---

## 将来拡張の可能性

本仕様の対象外。個別に再仕様化した上で追加します。

- 桃鉄対戦結果記録システムとの同一 DB 統合（順位・資産・物件数等）
- Web ダッシュボードによる戦績可視化（Next.js 等で Neon に直接接続）
- メンバー管理の動的化（現状は `.env` 固定だが、`Member` テーブルを正本化）
- 祝日・スキップ週の事前登録機能
- 通知設定のカスタマイズ（サイレント通知、個別 DM 切替など）

---

## ライセンス

未設定（個人利用）。

---

## 補足: AI エージェント向けドキュメント

このリポジトリでは AI コーディングエージェント（GitHub Copilot / Codex / Claude Code など）向けに以下のドキュメントを用意しています。人間の作業には不要ですが、AI にタスクを任せる場合は参照先として有効です。

- [`.github/copilot-instructions.md`](./.github/copilot-instructions.md): 常時ルール要約
- [`AGENTS.md`](./AGENTS.md): 作業手順・SSoT・禁止領域・既知の落とし穴（本体）
- [`.github/instructions/`](./.github/instructions/): ファイル領域別の実装・レビュー規約（`applyTo` で自動注入）
