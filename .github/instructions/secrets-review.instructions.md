---
applyTo: "**/*"
---

# Secrets & Logging Review Rules

Discord Bot token / Neon 接続文字列 / 死活監視 ping URL 等の秘匿値を扱う。ログ・PR・fixture への漏洩は運用事故。

## Secrets
- 本番は **Fly secrets** のみ（`fly secrets set KEY=...`）。ローカルは `.env.local`（`.gitignore` 対象）。
- commit 可能な env は `.env.example`（雛形）のみ。`.env*` の実値を追跡対象に入れない。
- `DISCORD_TOKEN` / `DATABASE_URL` / `DIRECT_URL` / `HEALTHCHECK_PING_URL` の**実値**をコード・fixture・テスト・ログ・PR・コミットに載せない。
- `FLY_API_TOKEN` は **app-scoped deploy token**（`fly tokens create deploy`）のみ。Personal Auth Token を CI に登録しない。漏洩時は即 revoke。
- `fly secrets unset` / 既存 secrets 上書きは **不可逆変更**。事前通知 + 停止窓外 + 手順書でのみ実施。ad-hoc は禁止。

## Logging
- `pino` で stdout に構造化 JSON。`console.log`/`console.error` を残さず `logger` に統一。
- `logger.redact` で token / 接続文字列 / `Authorization` を除去。redact 設定を緩めない。
- interaction payload 全量を出さない。必要な識別子（`interactionId` / `userId` / `customId` / `sessionId` / `weekKey` / `messageId`）に限定。
- 状態遷移ログは `from` / `to` / `reason` を含める。
- SQL bind 値を生出力しない。

## DIRECT_URL
- 実行時に参照・ログ出力しない（`drizzle.config.ts` 専用）。
