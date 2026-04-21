# TS3 Findings

## Summary
- 判定: 概ね適合 (High 0 / Med 0 / Low 2)
- Component/Slash ともに 3 秒 ack・cheap-first・zod narrow・DB 再取得の主経路は実装済み
- tamper 起因の状態改変経路なし

## Trust Boundary Matrix
| stage | check | 失敗時 | 位置 |
|---|---|---|---|
| guildId | 一致 | ephemeral reject | guards.ts:60-66,217-219; dispatcher.ts:38-42 |
| channelId | 一致 | ephemeral reject | guards.ts:68-74,220-222 |
| member | MEMBER_USER_IDS | ephemeral reject | guards.ts:76-82,223-225 |
| custom_id | zod safeParse | invalidCustomId | guards.ts:89-118; customId.ts:58-79,95-119 |
| session DB 再取得 | findSessionById | not found/stale | ask-session/button.ts:68-75; postpone-voting/button.ts:73-82 |
| state precondition | ASKING/POSTPONE_VOTING/deadline | stale/closed reject | guards.ts:134-172 |

## Findings
### F1: Slash reject 理由が潰れている [Low]
- ask-session/command.ts:33-35, cancel-week/command.ts:40-42
- assertGuildAndChannel 失敗でも notMember 固定文言。状態改変リスクなし、運用診断性のみ
- 推奨: button と同様の reason→message マップ

### F2: sessionNotFound が UUID 存在可否を暴露 [Low]
- guards.ts:120-132,199-208; messages.ts:9
- in-scope member に対し UUID 存在可否区別可 (内部詳細は未露出)
- 推奨: staleSession に統一

## Reject 文言
messages.ts:1-16 の全 12 文言いずれも sessionId/他者回答/内部状態詳細を含まない。outOfScopeButton は未使用。

## HMAC 再評価 (ADR-0016)
固定 private guild・固定 4 名の現脅威モデルでは HMAC 未導入維持は妥当。外部展開・非信頼メンバー混在時に ADR-0016 の再評価トリガどおり HMAC/バージョニング導入推奨。
