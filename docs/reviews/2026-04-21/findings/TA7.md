# TA7 Findings

## Summary
- 判定: 要改善 (High 0 / Medium 3 / Low 2)
- 良: customId parse/build は shared に集約、handler で split 直書きなし
- 懸念: ingress 責務が dispatcher/guards/handler で揺れ、shared↔feature の依存が双方向

## Layer Responsibility Matrix
| layer | ownership | files |
|---|---|---|
| ingress | 購読・top catch・ルーティング・button の一部 preflight/ack | dispatcher.ts:33-147 |
| shared guard/codec | guild/channel/member/session/customId 検証、reject reason→message、codec | guards.ts:21-227, customId.ts:1-122 |
| feature handlers | feature 固有 validate→mutate→render | ask/postpone/cancel の button/command |
| command def/sync | commands/definitions.ts, commands/sync.ts |
| reject copy | **実質 shared concern だが feature 配下** | features/interaction-reject/messages.ts |

## Findings
### F1: shared と feature の依存が双方向 [Medium]
- dispatcher.ts:10 / guards.ts:14 が features/interaction-reject/messages.ts を参照
- feature 側は dispatcher.ts の InteractionHandlerDeps 型を参照
- ingress/shared が feature に触れ、feature も ingress に触れる循環気味
- 推奨: InteractionHandlerDeps と reject message catalog を discord/shared/contracts へ移し片方向に

### F2: defer 責任主体が handler ごとに不一致 [Medium]
- dispatcher.ts:40-47,63-77; ask-session/button.ts:225-231; postpone-voting/button.ts:225-226; cancel-week/button.ts:24-25
- ask button は dispatcher 側 defer 前提、postpone/cancel button は handler 側 defer 前提
- 推奨: dispatcher 一元化 or handler 一元化で統一

### F3: cheap-first guard が重複、slash/button で reject 契約ズレ [Medium]
- dispatcher.ts:37-42; ask/postpone button 冒頭の再検証; slash 側 assertGuildAndChannel/assertMember の boolean API で reject reason 潰れ
- TS3 F1 (slash reject 理由潰れ) と同根
- 推奨: preflight を 1 つの typed API に寄せる or dispatcher を純粋ルータに

### F4: router が prefix literal に依存 [Low]
- customId.ts:78-79,114-121; dispatcher.ts:45,51,56
- handler は codec 経由、dispatcher は startsWith("ask:") 直書き
- 推奨: kind/prefix 定数か parse*Kind の薄い API を codec 側から

### F5: error handling の層契約が揃っていない [Low]
- ask/postpone button は AppResult/ResultAsync、ask command は exception/catch、cancel は imperative
- 推奨: 共通 AppError 契約 + dispatcher 翻訳

## TS3 との重複排除
TS3 は攻撃耐性 (tamper / zod narrow / DB 再取得 / 情報露出)。TA7 は責務配置と依存方向が主題。重なるのは /ask /cancel_week の reject 理由潰れだけで、TS3 は診断性視点、TA7 は guard 重複症状として扱う。

- pnpm test 227 pass 確認済
