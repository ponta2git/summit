# Summit

Summit は、固定 4 名で毎週遊ぶ「桃鉄 1 年勝負」の出欠確認を自動化する Discord Bot です。募集投稿、ボタン回答、締切判定、1 回だけの順延確認、開催通知、リマインドまでを扱います。

業務仕様の正典は [`requirements/base.md`](./requirements/base.md) です。この README は、セットアップ・開発・運用ドキュメントへの入口に絞っています。

## Features

- 毎週の自動募集投稿と手動 `/ask`
- 固定メンバー・設定済み時刻枠へのボタン回答
- 締切時点の開催 / 中止 / 順延判定
- 金曜から土曜への 1 回だけの順延投票
- 開催決定通知と開始前リマインド
- 今週の状況を見る `/status` と緊急スキップ用 `/cancel_week`
- PostgreSQL 永続化による再起動後の状態復元

## Tech stack

| 領域 | 技術 |
|---|---|
| Runtime | Node.js 24, TypeScript, ESM |
| Package manager | pnpm v10 |
| Discord | discord.js v14 |
| Database | PostgreSQL 16, Drizzle ORM, postgres.js |
| Scheduling | node-cron + DB-driven reconciliation |
| Validation / logging | zod v4, pino |
| Hosting | Fly.io 単一インスタンス, Neon PostgreSQL |
| Tests / checks | Vitest, oxlint, TypeScript, drizzle-kit |

## Requirements（前提）

- [`mise`](https://mise.jdx.dev/)（Node.js / pnpm のバージョン固定）
- Docker（ローカル PostgreSQL 用）
- Discord Application / Bot token
- Discord Guild、投稿先チャンネル、固定 4 名の User ID

## Quick start

```bash
git clone https://github.com/ponta2git/summit.git
cd summit

mise install
cp .env.example .env.local
cp summit.config.example.yml summit.config.yml
```

`.env.local` には secret と runtime env を設定します。

- `DISCORD_TOKEN`
- `DATABASE_URL`
- `DIRECT_URL`
- `TZ=Asia/Tokyo`
- optional `HEALTHCHECK_PING_URL`

`summit.config.yml` には非 secret のユーザー設定を記入します。

- Discord Guild ID
- 投稿先チャンネル ID
- 固定 4 名の User ID / 表示名
- スケジュール・時刻枠設定

その後、依存関係のインストール、DB 起動、migration、seed、slash command 同期、Bot 起動を行います。

```bash
pnpm setup
pnpm commands:sync
pnpm dev
```

Bot の招待には OAuth2 scopes `bot` / `applications.commands` が必要です。最小 Bot Permissions は `View Channel` / `Send Messages` / `Embed Links` です。

## Configuration（設定）

Summit は secret とユーザー向け設定を分離します。

| ファイル / 変数 | 用途 | Git 管理 |
|---|---|---|
| `.env.example` | ローカル env 雛形 | commit する |
| `.env.local` | ローカル secret / runtime env | commit しない |
| `summit.config.example.yml` | ユーザー設定雛形 | commit する |
| `summit.config.yml` | ローカルの非 secret 設定 | commit しない |
| `summit.config.production.yml` | 本番用ユーザー設定ソース | secret を含めず commit する |
| `SUMMIT_CONFIG_YAML` | アプリが読む YAML 本文 | 本番では Fly secret |

ローカルの package script は `summit.config.yml` を `SUMMIT_CONFIG_YAML` に詰めて起動します。本番では deploy 前に production config を stage します。

```bash
pnpm config:fly:stage
```

Discord token、DB URL、healthcheck ping URL の実値は commit しないでください。

## Common commands（主要コマンド）

| コマンド | 説明 |
|---|---|
| `pnpm dev` | `tsx watch` でローカル起動 |
| `pnpm build` | `dist/` に本番ビルド |
| `pnpm start` | ビルド済みアプリをローカル実行 |
| `pnpm typecheck` | TypeScript 型検査 |
| `pnpm lint` | oxlint |
| `pnpm lint:fix` | oxlint の自動修正 |
| `pnpm test` | 単体テスト |
| `pnpm test:integration` | DB 統合テスト |
| `pnpm ci` | 主要な CI 検証を直列実行 |
| `pnpm db:up` / `pnpm db:down` | ローカル PostgreSQL 起動 / 停止 |
| `pnpm db:generate` | Drizzle migration SQL 生成 |
| `pnpm db:migrate` | migration 適用 |
| `pnpm db:check` | Drizzle migration 整合性チェック |
| `pnpm db:seed` | 設定からローカル members を seed |
| `pnpm db:reset` | ローカル sessions / responses をリセット |
| `pnpm commands:sync` | guild-scoped slash commands を同期 |
| `pnpm deploy:production` | production config を stage して Fly.io へ deploy |

schema 変更時は `pnpm db:generate` で SQL を生成し、内容をレビューしてから `pnpm db:migrate` / `pnpm db:check` を実行します。`drizzle-kit push` は使いません。

## Development workflow（開発）

PR 前は次の順で検証します。

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

schema / migration / env に触れた場合は `pnpm db:check` も実行します。運用ガード、migration、CI に触れた場合は `pnpm verify:forbidden` / `pnpm verify:drift` も確認します。

ローカルで週次フローをやり直す場合は、専用コマンドで transient state をリセットします。

```bash
pnpm db:reset
pnpm db:reset --all # members も消すため、後で pnpm db:seed が必要
```

`pnpm db:reset` は非ローカル DB host では停止します。

## Deployment notes（本番運用）

本番は Fly.io の単一 machine / 単一 Bot process を前提にしています。cron と復旧処理は単一 active instance を前提にしているため、水平スケールしません。

deploy 前の基本手順:

1. Fly secrets に `DISCORD_TOKEN` / `DATABASE_URL` / `DIRECT_URL` / optional `HEALTHCHECK_PING_URL` を設定する。
2. ユーザー設定を変えた場合は `summit.config.production.yml` を更新する。
3. デプロイ禁止窓外で `pnpm deploy:production` を実行する。
4. slash command 定義を変えた場合は `pnpm commands:sync` を実行する。

金 17:30〜土 01:00 JST は deploy / restart / schema 変更を避けます。詳細な運用手順は [`docs/operations/`](./docs/operations/) にあります。

## Documentation map（ドキュメント）

| 知りたいこと | 入口 |
|---|---|
| 業務仕様・ユーザーに見える挙動 | [`requirements/base.md`](./requirements/base.md) |
| 運用・障害対応 | [`docs/operations/README.md`](./docs/operations/README.md) |
| 設計判断・背景 | [`docs/adr/README.md`](./docs/adr/README.md) |
| AI エージェント向け作業手順 | [`AGENTS.md`](./AGENTS.md) |
| 領域別の実装規約 | [`.github/instructions/`](./.github/instructions/) |

## License

ライセンス未設定です。個人利用のリポジトリです。
