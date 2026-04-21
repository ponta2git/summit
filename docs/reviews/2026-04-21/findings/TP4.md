# TP4 Findings

## Summary
- 判定: 要修正 / Medium 1 / Low 1
- 宣言側 (env/README/ADR/logger) と実装側の重大 drift: ping 送信実装が完全欠落
- **TP1 F5 (GPT-5.4) と独立に一致** (Haiku + TP1 で cross-verify 済、追加 review 省略)

## 宣言側
- env: src/env.ts:54-57 (URL 型、空で undefined)
- README: README.md:144, 289-291 (毎分 tick で HTTP GET)
- ADR: docs/adr/0005-operations-policy.md:54-57 (毎分 cron tick 成功時 ping)
- logger redact: src/logger.ts:5,13,23
- logger test: tests/logger/redact.test.ts:43,56,71,76

## 実装側
- ping 送信関数: **なし** (rg src/ で env.HEALTHCHECK_PING_URL は logger redact 宣言のみ)
- scheduler tasks (scheduler/index.ts:226-254): ask/deadline/postpone-deadline/reminder の 4 種、**ping task なし**
- HTTP client 呼び出し: Discord.js 以外の fetch/axios/undici/http.request 0 件
- テスト: env parse + redact のみ、ping 送信 test なし

## 差分
| 層 | 宣言 | 実装 |
| env | zod OK | 読み込まれない |
| README | 詳細 | なし |
| ADR | 設計明記 | なし |
| logger redact | 宣言あり | redact はするが送信側の実装なし |
| test | なし | なし |

## Findings
### F1: ping 送信実装が完全欠落 [Medium]
- scheduler/index.ts:226-254; env.ts:54; README:289-291; ADR-0005:56; TP1 F5
- ADR-0005 で「死活監視は毎分 cron tick 成功時に ping」と決定済、env/logger redact 実装済だが送信側ゼロ
- 推奨: 毎分 tick 内で `fetch(pingUrl, {method:'GET', timeout:5s})`、undefined 時 no-op、失敗 warn log only

### F2: ready ping との混同リスク [Low]
- 現行宣言は毎分のみ、ready ping は任意
- 現状は毎分実装で OK、追加で ready ping は判断で

## 不足テスト
- ping 送信 timing (毎分)
- HEALTHCHECK_PING_URL=undefined 時 no-op
- ping 失敗 (timeout/404) でプロセス継続
- redact: ping URL 実値がログに出ないこと

## Haiku cross-verify
- TP1 F5 (GPT-5.4 / boot-to-ready review) で同一 gap を独立指摘
- 本タスクの grep 結果と完全一致 (scheduler/index.ts の task 4 件、ping 実装 0 件)
- 追加 GPT-5.4 review 不要と判断 (既に別 GPT-5.4 review で裏付け済)
