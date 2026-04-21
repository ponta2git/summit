# TS2 Findings

## Summary
- 判定: 要改善
- High 0 / Medium 3 / Low 2

## Redact 設定インベントリ
- logger.ts:9-26
  - paths: DATABASE_URL / DIRECT_URL / HEALTHCHECK_PING_URL / DISCORD_TOKEN / token / authorization / Authorization / headers.authorization / headers.Authorization / env.* (上記4種)
  - remove: true (censor 未使用)
- 網羅状況:
  - token/URL/Authorization: トップレベル対応
  - payload 全量: call-site 側で識別子限定
  - **stacktrace: 除去設定なし** (Error そのまま構造化出力され得る)

## 漏洩リスクのある call-site
| file:line | risk | severity |
|---|---|---|
| logger.ts:10-24 | nested 系未網羅 (error.cause.headers.authorization 等) | Medium |
| discord/shared/dispatcher.ts:125-133 | err 生出力 | Medium |
| scheduler/index.ts:47,84,109-116,141-148,212 | error 生出力 (cron 系複数) | Medium |
| discord/shared/dispatcher.ts:64-70 | customId 生値出力 | Low |
| features/postpone-voting/button.ts:202-208,248-267 | customId 生値出力 | Low |

## from/to/reason coverage
- 充足: ask-session/settle.ts:54-60,80-87,118-127; reminder/send.ts:96-107
- 不足: postpone-voting/settle.ts:48-52,83-87; cancel-week/settle.ts:35-41,44-52

## Findings
- F1: Redact がトップレベル中心、例外ネストを取りこぼす [Medium]
- F2: raw error ログが多く、Discord/DB 由来詳細の露出余地 [Medium]
- F3: 一部 state 遷移で from/to/reason 構造化ログが未整備 [Medium]
- F4: console.* は src/**, tests/** で検出なし [Low]
- F5: process.env 直接参照は env.ts のみ (他はコメント) [Low]
