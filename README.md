# Summit

Summit は、固定 4 名で毎週金曜深夜に遊ぶ「桃鉄1年勝負」の出欠確認を自動化する Discord Bot です。金曜 18:00 に募集を出し、21:30 の締切で開催可否を判定し、欠席や未回答があれば土曜への順延確認まで扱います。Discord 上の募集・判定・再募集・リマインドを一つの運用フローにまとめ、毎週の手作業をなくすことが目的です。

業務仕様の正典は [`requirements/base.md`](./requirements/base.md) です。仕様判断に迷ったら必ずそちらを先に見てください。

## 前提
- 対応 OS: macOS / Linux（Windows 未検証）
- 必要ツール:
  - [`mise`](https://mise.jdx.dev/)（Node / pnpm の版を固定）
  - Node.js 24 LTS（`mise install` で入る）
  - pnpm v10（同上）
  - Docker（ローカル DB 用。Docker Desktop など Compose 実行環境）

`mise` を正本として Node / pnpm の版をそろえ、DB は Docker で起動します。手元の Node や別パッケージマネージャに合わせて読み替えないでください。

## 初回セットアップ
1. Discord Developer Portal で Application と Bot を作成し、Bot Token を取得する。
2. Bot を運用 Guild に招待する（必要 intents/permissions は `requirements/base.md` §10 を参照）。
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

## 主要コマンド
```bash
pnpm dev            # 開発起動
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
pnpm commands:sync  # Discord slash commands を guild-scoped で同期
```

schema を変えたら `pnpm db:generate` → 生成 SQL をレビュー → `pnpm db:migrate` → `pnpm db:check` の順。`drizzle-kit push` は使いません。slash command の定義を変えたら `pnpm commands:sync` を忘れないでください。

## 環境変数
詳細な一覧・意味・既定値は [`requirements/base.md` §10](./requirements/base.md) を参照してください。起動に直結する最小限だけ抜粋:

| 名前 | 例 | 概要 |
|---|---|---|
| `DISCORD_TOKEN` | `xxx` | Bot トークン |
| `DISCORD_GUILD_ID` | `12345...` | 運用 Discord サーバー（Guild）ID |
| `DISCORD_CHANNEL_ID` | `12345...` | 投稿先チャンネル ID |
| `MEMBER_USER_IDS` | `id1,id2,id3,id4` | 固定 4 名の User ID（カンマ区切り） |
| `DATABASE_URL` | `postgres://...` | アプリ用 DB 接続（Neon pooler） |
| `DIRECT_URL` | `postgres://...` | migration 用（unpooled）。`drizzle.config.ts` 専用 |
| `TZ` | `Asia/Tokyo` | タイムゾーン固定 |
| `POSTPONE_DEADLINE` | `24:00` | 順延確認の締切（翌日 00:00 JST） |
| `HEALTHCHECK_PING_URL` | (optional) | healthchecks.io URL。未設定なら ping 無効 |

アプリコードは `process.env` を直接読まず、`src/env.ts` で validate 済みの値を使う前提です。`.env*` や token / DB URL / ping URL の実値は絶対に commit しないでください。

## デプロイ
- ホスティングは **Fly.io**、常時起動・**単一インスタンス**運用。
- 本番 secrets は `fly secrets set KEY=...` で登録。
- **デプロイ禁止窓**: 金 17:30 〜 土 01:00 JST。開催当日の募集・判定と重なるため、この時間帯は deploy / restart / schema 変更をしません。

本番 deploy 前には最低でも `pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm build` を通してください。単一インスタンス前提のため、復旧やロールバックも「二重起動させない」ことを優先して実施してください。

## ライセンス
未設定（個人利用）。

---

## 補足: AI エージェント向けドキュメント
このリポジトリでは AI コーディングエージェント（GitHub Copilot / Codex / Claude Code など）向けに以下のドキュメントを用意しています。人間の作業には不要ですが、AI にタスクを任せる場合は参照先として有効です。

- [`.github/copilot-instructions.md`](./.github/copilot-instructions.md): 常時ルール要約
- [`AGENTS.md`](./AGENTS.md): 作業手順・SSoT・禁止領域・既知の落とし穴（本体）
- [`.github/instructions/runtime.instructions.md`](./.github/instructions/runtime.instructions.md): TS/Node 実装ルール（`src`/`tests` に自動適用）
