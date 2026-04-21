# TA3 Findings

## Summary
- 判定: Mostly compliant
- High 0 / Medium 1 / Low 2

- src/features, src/scheduler, src/discord/shared から src/db/repositories への直接 import なし (rg 0 件)
- src/time/** 以外に new Date() 直呼びなし (rg 0 件)
- AppContext は ports + clock のみ、Discord Client は別注入 (appContext.ts:11-24; dispatcher.ts:27-30; scheduler/index.ts:33-37)
- pnpm typecheck 通過

## Ports surface inventory
| port | methods | real | fake | drift |
| sessions | 15 種 | ports.real.ts:44-62 | testing/ports.ts:75-248 | **軽微 (fake が wall clock)** |
| responses | list/upsert | 64-67 | 256-290 | なし |
| members | findMemberIdByUserId/listMembers | 69-72 | 295-312 | なし |
| heldEvents | complete/find/listParticipants | 74-78 | 322-414 | なし |

## Findings
### F1: Fake ports が注入 clock を timestamp 生成に使わない [Medium]
- testing/ports.ts:128-136,145-154,166-170,186-190,237-242,373-380,457-460
- createTestAppContext は clock 注入可だが fake ports は updatedAt/createdAt に new Date()
- ADR-0018 主眼は守れているが fake の時間意味論が real と微妙にズレ、時刻依存テスト決定性を弱める
- 推奨: fake ports に timestamp factory、または clock を fake ports にも共有

### F2: appContext.ts 先頭コメントが現行テスト方針とズレ [Low]
- appContext.ts:1-3; testing/ports.ts:445-452; ADR-0018:93-105
- コメントは「tests は createAppContext({ports,clock})」だが実際の標準は createTestAppContext
- 推奨: ADR-0018 に合わせて修正

### F3: SessionsPort.isNonTerminal は未使用の純粋 helper [Low]
- ports.ts:75-76; ports.real.ts:60-61; 使用箇所 0 件
- 純粋述語なので port ではなく domain helper に戻す検討

## 過剰/過少抽象
- 過少抽象なし: ctx.ports/ctx.clock 一貫使用 (ask-session/send.ts:50-57; postpone-voting/button.ts:73-82; cancel-week/settle.ts:27-30; scheduler/index.ts:77-79)
- Discord Client は AppContext 外 (ADR-0018 整合)
- 純粋関数への過剰注入なし (evaluateDeadline, evaluatePostponeVote, renderAskBody は pure)
- ports 粒度は適切 (workflow 単位ではなく sessions/responses/members/heldEvents 集約)
