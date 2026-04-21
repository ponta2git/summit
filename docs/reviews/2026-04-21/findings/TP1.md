# TP1 Findings

## Summary
- 判定: 要修正
- High 2 / Medium 3 / Low 0

## Boot-to-ready シーケンス
| phase | 観測可否 | ログ | 改善余地 |
|---|---|---|---|
| module eval / createAppContext / client / handler 登録 | 不可 (index.ts:15-17) | なし | boot phase log / bootId |
| reconcileMembers | 部分可 (members/reconcile.ts:74-76) | 完了のみ | elapsedMs, row counts |
| client.login | 部分可 (index.ts:65-83) | 完了後 "Discord bot started" | start/end 分離 |
| runStartupRecovery | 部分可 (scheduler/index.ts:170-206) | overdue session 単位のみ | start/end, scanned/due counts |
| createAskScheduler | 不可 (index.ts:91-92) | なし | "ready" log をここで |

## Findings
### F1: "started" ログが ready を表していない [High]
- index.ts:77-92, logger.ts:7-27
- "Discord bot started." は login 直後で recovery / scheduler より前。SRE 視点で ready 判定に使えない
- 推奨: phase=`login|reconcile|startupRecovery|scheduler|ready`, elapsedMs, bootId 付与、ready は scheduler 生成後別ログ

### F2: restart 中に ask cron 窓を跨ぐと取りこぼす [High]
- scheduler/index.ts:159-214,226-253; ask-session/send.ts:147-176
- startup recovery は既存 non-terminal session だけ再処理、未作成の金曜 ask を補完しない
- rolling deploy のダウン窓が ask cron 境界跨ぎ → 週の募集消失
- 推奨: startup 時に「今週 ask 未作成か」を DB 補完判定する catch-up 追加

### F3: startup recovery N+1 線形走査 [Medium]
- sessions.ts:318-325; scheduler/index.ts:166-210; responses.ts:30-38; postpone-voting/settle.ts:99-105; reminder/send.ts:137-182
- findNonTerminalSessions で全件取得 + JS 判定 + per-session fan-out
- 推奨: due 別個別 query + response preload/batch

### F4: startup recovery 1 session 失敗で全停止 [Medium]
- scheduler/index.ts:165-213 (TA1 F1 と同根)
- 推奨: per-session isolate

### F5: HEALTHCHECK ping 未実装 [Medium]
- README.md:265,287-291; env.ts:54; logger.ts:5,13,23
- 設定/redact はあるが送信実装なし
- 推奨: ready 後 / 毎分 tick 成功時 ping、未設定時 no-op 維持

## 不足テスト/観測
- missed ask window の startup catch-up test
- runStartupRecovery per-session isolate test
- boot phase log snapshot (phase / elapsedMs / ready)
- healthcheck ping timing test
- reconcileMembers / login 並列化は現状逐次推奨 (index.ts:15-17,60-65)
