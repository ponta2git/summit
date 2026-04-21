# TA4 Findings

## Summary
- 判定: Low-Medium (High 0 / Medium 2 / Low 2)
- ADR-0018 方針は浸透。repository 直 mock は **なし** (vi.mock 残存は renderer/collaborator/logger/schema stub のみ、0018 禁止事項には抵触せず)
- tests/testing/ports.ts:41-66,452-464; src/db/ports.real.ts:44-85

## Inventory
- createTestAppContext 利用: 12 / 29 files
- createAppContext 利用: 0 / 29 (integration で未経由)
- vi.mock 残存: members/reconcile.test.ts:8,17; scheduler/deadline.test.ts:9,12; discord/commands/cancelWeek.test.ts:13,18; discord/interactions.test.ts:22 (いずれも非-repository)

## Findings
### F1: ID/fake 内部 timestamp の決定性未完成 [Medium]
- tests/testing/ports.ts:104-105,128,136,148,169,189,241,374,391,452-464 で `new Date()` 直呼び
- production ID は randomUUID() 直呼び (features/ask-session/send.ts:1,77; postpone-voting/button.ts:1,101-107; cancel-week/command.ts:1,45)
- app logic の時計は固定できるが fake 側の createdAt/updatedAt は非決定
- TA3 F1 (fake が clock を使わない) と同根。R8 統合候補

### F2: integration が real ports/AppContext 合成を経由しない [Medium]
- tests/integration/sessions.contract.test.ts:7-16 が drizzle+repository を直接呼ぶ
- makeRealPorts()/createAppContext() を通る smoke/contract なし
- src/appContext.ts:21-24; db/ports.real.ts:80-85

### F3: seed ergonomics helper 不足 [Low]
- FakePortsSeed 1 個のみ。seedSession/seedResponses helper なし
- deadline.test.ts:57,94,141; postponeButton.test.ts:80-83,108-118,243-253 で手組み繰り返し

### F4: docs/comment drift [Low]
- src/appContext.ts:1-3 コメントが「createAppContext({ports,clock})」と読めるが実際は createTestAppContext
- ADR-0018:29-30,58-59 の例示パスが現行 (src/db/ports.ts, ports.real.ts) とずれ

## Fake fidelity
- Signature drift 耐性: 良好 (fake/real 同 interface、typecheck 通過)
- sessions/responses: CAS/unique 模倣、contract test で実 DB と比較済
- heldEvents/members: fake 実装はあるが real vs fake contract なし

## 不足観点
- createAppContext/makeRealPorts を通す integration smoke
- heldEvents/members の fake-vs-real contract
- tests/testing/ports.ts 肥大 (実装+call log+factory で 465 行)

## TA3 / ADR-0018 整合
- ADR-0018 禁止 (vi.mock を repositories に新規追加) は未違反
- TA3 F1 と F1 が同根 (clock を fake ports に浸透させる必要)

## Validation
- pnpm typecheck ✅
