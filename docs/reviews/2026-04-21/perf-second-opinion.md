# Perf Second Opinion (gpt-5.4)

## 観点の漏れ/評価
- **昇格 High**: 起動フェーズ / restart recovery, 時刻境界 drift (23:59→00:00 JST handoff), healthcheck drift (env に宣言あるが実装欠如の可能性), reminder claim stuck (ADR-0024 既知)
- **降格**: N+1, query efficiency 一般論, Neon pooler 一般論, zod/neverthrow/logger overhead, build size, discord.js cache, memory leak, HeldEvent tx (Medium 十分)
- **保留**: Docker/Fly build cache (Dockerfile/fly.toml が repo 上に無く深掘り不能)

## 評価方法改善
- wall-clock + query count + structured log 主軸
- 一部 SQL だけ EXPLAIN ANALYZE (`findDueAskingSessions`, `findDuePostponeVotingSessions`, `findDueReminderSessions`, `findNonTerminalSessions`)
- boot/recovery は profiler 不要、ログ時刻差で十分
- 4 concurrent interaction で synthetic 再現のみ
- 429 はベンチ不要、mocked delay + rate-limit log 観測

## タスク分解 6 項目
1. 起動フェーズレビュー (index.ts / scheduler / README deploy)
2. DB I/O レビュー (client.ts / sessions repo / heldEvents / button handlers)
3. 時刻境界レビュー (config.ts / time/* / scheduler / tests)
4. Discord delivery / 429 レビュー (dispatcher, ask/postpone/reminder send)
5. CI / deploy latency レビュー (.github/workflows/ci.yml / README deploy)
6. 運用観測 drift レビュー (env.ts / logger / README healthcheck)

## 最終 11 観点
1. 起動フェーズ / restart recovery (5.4, High)
2. 時刻境界 drift (5.4, High)
3. Reminder claim / stuck (5.4, High)
4. Healthcheck / observability drift (5.4-mini, High)
5. DB I/O パス (5.4, Medium)
6. HeldEvent atomic completion (5.4-mini, Medium)
7. Discord 429 / back-pressure (5.4, Medium)
8. CI install latency (5.4-mini, Medium-Low)
9. Migrate runtime (5.4-mini, Medium-Low)
10. Build/deploy cache (5.4-mini, Low)
11. Runtime overhead hygiene (5.4-mini, Low)
