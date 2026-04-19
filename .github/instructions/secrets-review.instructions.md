---
applyTo: "**/*"
---

# Secrets & Logging Review Rules

本 Bot は Discord Bot token / Neon 接続文字列 / 死活監視 ping URL などの秘匿値を扱う。ログ・PR・fixture への漏洩は運用事故に直結する。本書はリポジトリ全体に適用する。

## Required patterns

### Secrets の取り扱い
- 本番 secrets は **Fly secrets** のみ（`fly secrets set KEY=...`）。ローカルは `.env.local`（`.gitignore` 対象）。
- commit 可能な env ファイルは `.env.example` の雛形のみ。`.env*` の実値ファイルを追跡対象に入れない。
- `DISCORD_TOKEN` / `DATABASE_URL` / `DIRECT_URL` / `HEALTHCHECK_PING_URL` の**実値**をコード・fixture・テスト・ログ・PR 本文・コミットメッセージに載せない。
- `FLY_API_TOKEN` は **app-scoped deploy token**（`fly tokens create deploy`）のみ。Personal Auth Token を CI に登録しない。漏洩時は即 revoke。
- `fly secrets unset` や既存 secrets の上書きは**不可逆変更**として扱う。明示的なローテーション手順（事前通知 + 停止窓外 + 手順書に沿った実施）でのみ許可し、ad-hoc な上書きはしない。

### ログ衛生
- ログは `pino` で stdout に構造化 JSON を出力する。`console.log` / `console.error` を残さず、全経路を `logger` に統一する。
- `logger` の `redact` paths で token / 接続文字列 / `Authorization` ヘッダなどを除去する。redact 設定を緩めない。
- interaction payload 全量をログに出さない。必要な識別子（`interactionId` / `userId` / `customId` / `sessionId` / `weekKey` / `messageId` 等）に限定する。
- 状態遷移ログには `from` / `to` / `reason` を含める。

### DB アクセスのログ整合
- `DIRECT_URL` を実行時に参照・ログ出力しない（`drizzle.config.ts` 専用）。
- SQL クエリログで bind 値を生出力しない（Drizzle のプレースホルダに委ねる）。

## Observed anti-patterns
- テスト fixture に実 token / 実接続文字列を埋め込む。
- debug のために payload 全体・env オブジェクト全体をそのまま出力する。
- redact 設定を「一時的に」外したまま commit する。
- `.env.local` や secrets ファイルを uncommitted のまま PR ブランチに追加する。
- コミットメッセージ・PR 本文・チャンネル投稿に secrets を貼る。

## Review checklist
- 差分に token / 接続文字列 / ping URL の形状が含まれていないか。
- ログ出力のキーが最小限で、秘匿値が redact されているか。
- `.env.local` や追跡外であるべき secrets ファイルが追跡対象に入っていないか。
- `DIRECT_URL` がアプリコードから参照されていないか（`drizzle.config.ts` 以外でヒットしないこと）。
- `console.*` 呼び出しが残っていないか。
