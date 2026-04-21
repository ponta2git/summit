# TA1 Findings

## Summary
- 判定: 要修正
- High 0 / Medium 2 / Low 1

## Findings
### F1: startup recovery が 1 件失敗で全走査中断 [Medium]
- src/scheduler/index.ts:165-213, tests/scheduler/deadline.test.ts:121-195
- runStartupRecovery 全体が 1 つの try/catch。1 session throw で残り非終端が未処理 → 次 cron まで遅延
- 推奨: session ごとの try/catch 分割 + 継続性テスト

### F2: ASKING deadline tick だけ per-session 隔離なし [Medium]
- src/scheduler/index.ts:73-86, 96-118, 129-149
- postpone/reminder は per-session isolate、ASKING tick だけ非。失敗モデル不統一
- 推奨: 同パターンに揃える

### F3: DB handle 生成が composition root 外 [Low]
- src/db/client.ts:12-21, src/appContext.ts:6,21-24, src/index.ts:15
- Client は root でのみ生成 (ADR-0018 OK)、DB は module scope singleton で捕捉される
- 推奨: DB も root/factory で遅延生成し起動順序を index.ts で一望できるように

## 起動/停止シーケンス (抽出済み)
index.ts module 評価 → createAppContext → Discord Client 生成 → interaction handler register → SIGINT/SIGTERM once → run() → reconcileMembers → login → runStartupRecovery → createAskScheduler (auto-start 4 crons)
shutdown: beginShutdown (idempotent) → scheduler stop → in-flight drain → DB close → client destroy → exit(0)

## 不足テスト
- 起動順序 integration test
- shutdown 厳密順序 test
- SIGTERM+SIGINT 交差多重発火 test
- runStartupRecovery 継続性 test
- runDeadlineTick 継続性 test
