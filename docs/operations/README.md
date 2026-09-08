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
| scheduler wake / timer / worker の挙動を確認したい | [scheduler.md](./scheduler.md) |
| 起動時に `reconciler` が連発 / 締切再計算が暴れる | [recovery.md](./recovery.md) case 1 / 7 |
| `pnpm db:migrate` が途中で失敗した | [migration.md](./migration.md) §ロールバック (`momo-db` リポジトリで対応) |
| Discord token / DATABASE_URL を rotate したい | [secrets-rotation.md](./secrets-rotation.md) |
| Neon インスタンスを restore したい | [backup.md](./backup.md) |
| Bot が応答しない / 起動状態を確認したい | [recovery.md](./recovery.md) case 1 + `/status` |

## 実行権限と準備

運用手順の調査・文書修正と、production での実行を区別する。runbook に command が載っていることや tool が利用可能なことは、実行許可ではない。production の変更には `AGENTS.md` の明示権限が必要で、同じ対象・操作について既に得た許可は再確認しない。

実行前に対象環境、操作範囲、該当 SOP、禁止窓、成功判定、復旧方法を照合する。許可が未取得なら、許可済みの範囲で差分・手順・検証結果を具体化してから対象操作の承認を求める。調査中に運用境界の不明点・矛盾を見つけた場合は、対象操作を止めて根拠と必要な判断を示す。独立した文書確認は継続できる。

## 共通原則

1. **DB が正本** — Discord 表示は DB から再構築する。手動 `UPDATE` / `DELETE` で表示を直そうとしない。
2. **本番 DB 破壊操作禁止** — `DROP` / `TRUNCATE` / `fly ssh` 経由の生 SQL / 手動 `UPDATE` は `docs/db-rule.md` で禁止。再起動による reconciler の復旧を選ぶ場合も、該当 SOP・実行権限・禁止窓に従う。
3. **デプロイ禁止窓**: 金 17:30〜土 01:00 JST。本番への deploy / restart / migration / schema 変更を行わない。本書を運用上の正本とする。
4. **単一インスタンス前提**: Fly app を scale しない / cron を多重登録しない / in-memory 状態を信頼しない。
5. **secrets 実値をログ・コミット・PR に載せない** — token / 接続文字列は `.env.example` の placeholder のみ commit 可。

## 連絡先 / 監視

- 運用観測: 構造化ログと `/status`。外部pingはアプリから送信しない
- ログ: `fly logs -a summit-momotetsu` (構造化 JSON、`event` で grep)
- DB console: Neon dashboard
- Discord guild / channel: `SUMMIT_CONFIG_YAML` (from `summit.config.production.yml`)

> 個人開発 Bot のため on-call ローテーション・PagerDuty 等は不要。異常時は Fly logs と `/status` で確認する。
