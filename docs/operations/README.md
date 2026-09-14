# Summit Operations Runbook

Summit Discord Bot の **運用入口**。障害対応 / migration / secrets rotation / backup / 時刻 skew 等の SOP を集約する。AI/人間どちらも `症状 → 該当 SOP` で逆引きできることを目的とする。

仕様・設計・AI の入口との関係は次の通り:

- **What**: `requirements/base.md`
- **Why / design contract**: `docs/architecture.md` と `docs/*-rule.md`
- **How (運用)**: 本ディレクトリ ← ここ
- **How (実装)**: production code と test。探索入口は `docs/README.md`
- **AI protocol**: `AGENTS.md`

## 構成

| ファイル | 主題 | 設計正本 |
|---|---|---|
| [recovery.md](./recovery.md) | 障害ケース 1〜7 + 復旧不能ケースの SOP | `docs/architecture.md`, `docs/db-rule.md` |
| [scheduler.md](./scheduler.md) | DB-driven scheduler / Neon compute cost / missed wake 対応 | `docs/architecture.md` |
| [outbox.md](./outbox.md) | outbox 観測値 / retention / stranded 対応 | `docs/db-rule.md` |
| [result-notifications.md](./result-notifications.md) | OCR・分析通知の状態確認、再試行、ON/OFF、互換性 | `docs/db-rule.md`, `docs/discord-rule.md` |
| [time-skew.md](./time-skew.md) | サーバ clock 異常時の SOP | `docs/time-rule.md` |
| [migration.md](./migration.md) | momo-db migration と Summit consumer の連携・適用・復旧 | `docs/db-rule.md`, `../momo-db/docs/development.md` |
| [backup.md](./backup.md) | Neon PITR / 想定 RPO/RTO / restore 手順 | `docs/db-rule.md` |
| [secrets-rotation.md](./secrets-rotation.md) | Fly secrets 更新時の手順と影響範囲 | `docs/dev-rule.md`, `docs/architecture.md` |

## 症状逆引き

| 症状 | 第一参照 |
|---|---|
| Discord 表示が更新されない | [recovery.md](./recovery.md) case 4 / 5 + [outbox.md](./outbox.md) |
| `/status` の `now` が JST と数分以上ずれている | [time-skew.md](./time-skew.md) |
| outbox metrics の `level=warn` が来た | [outbox.md](./outbox.md) §警告対応 |
| OCR・分析通知が届かない、同じ通知を再試行したい | [result-notifications.md](./result-notifications.md) |
| scheduler wake / timer / worker の挙動を確認したい | [scheduler.md](./scheduler.md) |
| 起動時に `reconciler` が連発 / 締切再計算が暴れる | [recovery.md](./recovery.md) case 1 / 7 |
| `pnpm db:migrate` が途中で失敗した | [migration.md](./migration.md) §ロールバック (`momo-db` リポジトリで対応) |
| Discord token / DATABASE_URL を rotate したい | [secrets-rotation.md](./secrets-rotation.md) |
| Neon インスタンスを restore したい | [backup.md](./backup.md) |
| Bot が応答しない / 起動状態を確認したい | [recovery.md](./recovery.md) case 1 + `/status` |
| slash command 定義を更新したい / 同期結果が不明 | 本書 §本番Discordコマンド同期 |

## 実行権限と準備

運用手順の調査・文書修正と、production での実行を区別する。runbook に command が載っていることや tool が利用可能なことは、実行許可ではない。production の変更には `AGENTS.md` の明示権限が必要で、同じ対象・操作について既に得た許可は再確認しない。

実行前に対象環境、操作範囲、該当 SOP、禁止窓、成功判定、復旧方法を照合する。許可が未取得なら、許可済みの範囲で差分・手順・検証結果を具体化してから対象操作の承認を求める。調査中に運用境界の不明点・矛盾を見つけた場合は、対象操作を止めて根拠と必要な判断を示す。独立した文書確認は継続できる。

## 共通原則

1. **DB が正本** — Discord 表示は DB から再構築する。手動 `UPDATE` / `DELETE` で表示を直そうとしない。
2. **本番 DB 破壊操作禁止** — `DROP` / `TRUNCATE` / `fly ssh` 経由の生 SQL / 手動 `UPDATE` は `docs/db-rule.md` で禁止。再起動による reconciler の復旧を選ぶ場合も、該当 SOP・実行権限・禁止窓に従う。
3. **デプロイ禁止窓**: 金 17:30〜土 01:00 JST。本番への deploy / restart / migration / schema 変更を行わない。本書を運用上の正本とする。
4. **単一インスタンス前提**: Fly app を scale しない / cron を多重登録しない / in-memory 状態を信頼しない。
5. **secrets 実値をログ・コミット・PR に載せない** — token / 接続文字列は `.env.example` の placeholder のみ commit 可。

## 本番Discordコマンド同期

定義を変えた場合だけ、**運用 PC から手動実行**する。Fly SSH、Bot 起動時、deploy hook では実行しない。稼働中 Bot と CPU / メモリを競合させず、DB / member / schedule 設定を不要にするための運用境界である。Fly 側のメモリ増強・swap 追加や GitHub Actions への token 登録は不要。

### 準備

1. 本書 §実行権限と準備に従い、対象 application / guild と更新権限を確認する。対象 guild のその application の command 一覧を丸ごと置換するため、別の管理元の command が混在していないことを確認する。同じ対象を複数の運用端末から同時に更新しない。
2. 運用 PC の checkout を deploy 済み revision と照合し、`git status --short` と `git rev-parse HEAD` で未コミット差分がないこと・実行 SHA を記録する。固定 Node / pnpm と依存関係を用意する。定義の変更がなければ同期を追加実行しない。
3. 本番 token は既存の安全な保管元から受け渡す。Fly process の env dump やログから抽出せず、同期のためだけに token を再発行しない。token をコマンド引数・shell 履歴・作業ログに書かない。
4. 運用 PC の Summit ディレクトリに `.env.commands.production.local` を明示して用意し、次の **3 項目だけ**を設定する（下記は placeholder）。gitignore 対象であることを `git check-ignore .env.commands.production.local` で確認し、所有者だけが読めるよう `chmod 600 .env.commands.production.local` を実行する。Bot 用 `.env.local` や production YAML は流用しない。

```dotenv
DISCORD_TOKEN=replace-with-production-bot-token
DISCORD_APPLICATION_ID=replace-with-production-application-id
DISCORD_GUILD_ID=replace-with-production-guild-id
```

application ID は Discord Developer Portal、guild ID は対象サーバーと照合する。本番 CLI は token から application ID を推測せず、ID 不足を開発設定で補わない。3 項目を安全に環境へ注入済みの場合は、以下の `dotenv` 部分を省いて package script を直接実行してもよい。

### 確認・適用

まず GET のみで差分を確認する。`-e` は対象ファイルの明示、`-o` は既存 shell の開発用変数よりファイルの値を優先する指定。3 項目の欠落がないことを先に確認し、secret の表示オプションは使わない（[dotenv-cli の公式説明](https://github.com/entropitor/dotenv-cli#override)）。

```bash
pnpm exec dotenv -e .env.commands.production.local -o -- pnpm commands:sync:production --check
```

`matched` なら変更不要。`different` の場合だけ、対象 ID・実行 SHA・今回の command 定義差分を確認してから適用する。

```bash
pnpm exec dotenv -e .env.commands.production.local -o -- pnpm commands:sync:production
```

CLI 自体が GET → 差分時のみ PUT → GET で検証する。`synced` または `matched` と終了コードの成功を記録し、必要な Discord 上の利用確認を行う。親は worker の終了を待ち、全体 deadline / 終了猶予 / リクエスト timeout の値は `src/commands/sync.protocol.ts` を参照する。

### 失敗・結果不明からの復旧

ログの `event=commands.sync`、`status`、`reason` と終了コードを合わせて判断する。終了コードの対応は `getSyncExitCode`（`src/commands/sync.protocol.ts`）が実体となる。

| 終了コード / 結果 | 次の操作 |
|---|---|
| `0` / `matched`, `synced` | 定義の一致を確認済み。追加の PUT は不要 |
| `2` / `different` | 読み取り成功・差分あり。対象と revision を確認してから適用を判断 |
| `1` / `failed` | 設定不備・実行場所・認証・API エラー等の `reason` を確認。入力や権限を修正して読み取りから再開 |
| `3` / `unknown` | 書き込み結果を断定できない。適用を繰り返さず `--check` で登録状態を確認 |
| `124` / `deadline_exceeded`、`130` / `cancelled` | 処理を中断。apply の結果は不明として、同様に `--check` から再開 |

- `rate_limited` は報告された `retryAfterMs` 以上待ってから、手動で `--check` を行う。自動 retry やループ実行をしない。
- PUT 後の確認失敗・通信切断でも Discord 側へ適用済みの可能性がある。`--check` が `matched` なら再適用不要、`different` なら対象・revision・権限を再確認して必要な適用を判断する。確認自体が失敗する間は状態を成功・未適用と断定しない。
- 誤った定義の復旧は、対象 Bot と互換な復旧 revision を決め、その定義で同じ確認・適用手順を行う。CLI は自動 rollback しない。Bot の redeploy / restart や token rotation が必要になった場合は別の SOP と操作権限で扱う。

## 連絡先 / 監視

- 運用観測: 構造化ログと `/status`。外部pingはアプリから送信しない
- ログ: `fly logs -a summit-momotetsu` (構造化 JSON、`event` で grep)
- DB console: Neon dashboard
- Discord guild / channel: `SUMMIT_CONFIG_YAML` (from `summit.config.production.yml`)

> 個人開発 Bot のため on-call ローテーション・PagerDuty 等は不要。異常時は Fly logs と `/status` で確認する。
