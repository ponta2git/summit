---
applyTo: "**/*"
---

# Secrets & Logging Review Rules

## Required patterns
- token / `DATABASE_URL` / `DIRECT_URL` / `HEALTHCHECK_PING_URL` の実値をコード・fixture・ログ・PR 本文に載せない。
- `.env*` の実値ファイルを commit しない（許可は `.env.example` の雛形のみ）。
- interaction payload 全量や `Authorization` をログに出さない。
- `console.log` / `console.error` を残さず `pino` に統一する。
- `logger` の redact paths を維持し、秘匿キーが出力に残らないことを担保する。

## Observed anti-patterns
- テスト fixture に実 token / 接続文字列を埋め込む。
- debug のために payload 全体をそのまま出力する。
- redact 設定を変更して秘密情報を露出させる。

## Review checklist
- 差分に秘匿値の形状が含まれていないか。
- ログ出力のキーが最小限で、機密値が除去されているか。
- `.env.local` や secrets ファイルが追跡対象に入っていないか。

## 参照
- `requirements/base.md` §10, §13
- `.github/instructions/runtime.instructions.md`
- `AGENTS.md`
