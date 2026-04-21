# TP6 Findings

## Summary
- 判定: Medium。規模的に discord.js 標準依存は妥当だが **429 観測性ゼロ**

## Send/edit callsites (抜粋)
- features/ask-session/send.ts:116,210 channel.send (cron/postpone-settle)
- features/ask-session/button.ts:172 message.edit / 215,252 followUp (最大4並列)
- features/ask-session/messageEditor.ts:26 / settle.ts:66,74
- features/postpone-voting/button.ts:160,212,244 (最大4並列)
- features/postpone-voting/messageEditor.ts:31
- features/reminder/send.ts:169 (DB claim で抑制)
- features/cancel-week/button.ts + settle.ts
- discord/shared/dispatcher.ts:41/74/95/137 (reply/followUp reject系)
- render.ts/viewModel.ts は pure I/O なし

## discord.js 設定
- src/discord/client.ts:15-19: intents + allowedMentions のみ
- `rest` 未指定 → デフォルト (global 50req/s, retries 3, timeout 15s)
- package.json:41 v14.26.3

## 429 観測
- RateLimit/429/retryAfter/RESTEvents.RateLimited の購読・ログ 0件
- logger.ts:7-29 専用設定なし
- 429 専用テストなし (generic send failure test のみ tests/discord/settle/*)

## Findings
### F1: 429 が“起きても見えない” [Medium]
- src/discord/client.ts:15-19; logger.ts:7-29
- discord.js 内部 retry は成功時 app log に出ない、失敗時も retryAfter/bucket/route が出ない
- 推奨: client.rest.on(RESTEvents.RateLimited) を購読し route/global/scope/retryAfter/hash を structured log

### F2: アプリ側 coalescing なし [Low-Medium]
- features/ask-session/button.ts:131-188,247-276; postpone-voting/button.ts:127-180,241-274
- 同時押下で edit + followUp がそのまま積まれる
- 整合性は DB CAS/upsert で担保済、送信量削減なし
- 現規模で許容、429 実績が出たら per-message edit coalescing 検討

### F3: cron fan-out 抑制は妥当 [Low]
- scheduler/index.ts:79-82,103-108,135-139,251-253; index.ts:85-92
- for...of await 直列 + noOverlap:true、startup recovery も scheduler 前
- 変更不要

### F4: interaction token 15分超過は低リスクだが無観測 [Low]
- dispatcher.ts:39-42,63-77; feature button.ts:247-276
- followUp は即時実行で遅延ジョブ化なし、prolonged REST stall 時の検知機構なし

### F5: 標準依存自体は妥当 [Low]
- 固定4人・単一チャンネル・経路少で discord.js デフォルトで十分
- 改善優先順: 観測性 > 追加 retry/backoff

## 推奨差分まとめ
- 最小: RateLimited event 購読 + redact-safe log
- 中期: 429 test、reminder 系の timeout lower
- 任意: edit coalescing (429 実績後)
