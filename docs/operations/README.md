# Summit Operations Runbook

Summit Discord Bot の **運用入口**。障害対応 / migration / secrets rotation / backup / 時刻 skew 等の SOP を集約する。AI/人間どちらも `症状 → 該当 SOP` で逆引きできることを目的とする。

仕様 (`requirements/base.md`)・常時ルール (`AGENTS.md` / `.github/copilot-instructions.md`)・判断根拠 (`docs/adr/`) との関係は次の通り:

- **What**: `requirements/base.md`
- **Why**: `docs/adr/`
- **How (運用)**: 本ディレクトリ ← ここ
- **How (実装)**: `.github/instructions/*.md`

## 構成

| ファイル | 主題 | 主な参照 ADR |
|---|---|---|
| [recovery.md](./recovery.md) | 障害ケース 1〜7 + 復旧不能ケースの SOP | 0001, 0024, 0033, 0035 |
| [scheduler.md](./scheduler.md) | DB-driven scheduler / Neon compute cost / missed wake 対応 | 0047 |
| [outbox.md](./outbox.md) | outbox 観測値 / retention / stranded 対応 | 0035, 0042, 0043 |
| [time-skew.md](./time-skew.md) | サーバ clock 異常時の SOP | 0044 |
| [migration.md](./migration.md) | drizzle migration の生成・適用・ロールバック | 0008, 0019 |
| [backup.md](./backup.md) | Neon PITR / 想定 RPO/RTO / restore 手順 | 0008 |
| [secrets-rotation.md](./secrets-rotation.md) | Fly secrets 更新時の手順と影響範囲 | (env / secrets-review) |

## 症状逆引き

| 症状 | 第一参照 |
|---|---|
| Discord 表示が更新されない | [recovery.md](./recovery.md) case 4 / 5 + [outbox.md](./outbox.md) |
| `/status` の `now` が JST と数分以上ずれている | [time-skew.md](./time-skew.md) |
| outbox metrics の `level=warn` が来た | [outbox.md](./outbox.md) §警告対応 |
| scheduler wake / timer / worker の挙動を確認したい | [scheduler.md](./scheduler.md) |
| 起動時に `reconciler` が連発 / 締切再計算が暴れる | [recovery.md](./recovery.md) case 1 / 7 |
| `pnpm db:migrate` が途中で失敗した | [migration.md](./migration.md) §ロールバック |
| Discord token / DATABASE_URL を rotate したい | [secrets-rotation.md](./secrets-rotation.md) |
| Neon インスタンスを restore したい | [backup.md](./backup.md) |
| healthchecks.io が ping 切れの通知を出した | [recovery.md](./recovery.md) case 1 + [secrets-rotation.md](./secrets-rotation.md) |

## 共通原則 (再掲)

1. **DB が正本** — Discord 表示は DB から再構築する。手動 `UPDATE` / `DELETE` で表示を直そうとしない (ADR-0001)。
2. **本番 DB 破壊操作禁止** — `DROP` / `TRUNCATE` / `fly ssh` 経由の生 SQL / 手動 `UPDATE` は AGENTS.md `prohibited_actions` で禁止。復旧は基本「Fly redeploy で再起動 → reconciler が収束」。
3. **デプロイ禁止窓**: 金 17:30〜土 01:00 JST。本番への deploy / restart / migration / schema 変更を行わない (AGENTS.md)。
4. **単一インスタンス前提**: Fly app を scale しない / cron を多重登録しない / in-memory 状態を信頼しない (ADR-0001, ADR-0033)。
5. **secrets 実値をログ・コミット・PR に載せない** — token / 接続文字列 / ping URL は `.env.example` の placeholder のみ commit 可 (`.github/instructions/secrets-review.instructions.md`)。

## 連絡先 / 監視

- 死活監視: healthchecks.io (`HEALTHCHECK_PING_URL`)
- ログ: `fly logs -a summit` (構造化 JSON、`event` で grep)
- DB console: Neon dashboard
- Discord guild / channel: `SUMMIT_CONFIG_YAML` (from `summit.config.production.yml`)

> 個人開発 Bot のため on-call ローテーション・PagerDuty 等は不要。alert 手段は healthchecks.io のメール通知のみ。
