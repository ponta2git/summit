# TA2 Findings

## Summary
- 判定: Medium (Medium 2 / Low 3)
- madge で **実測 4 循環**、TA7 F1 を独立追認

## Dep graph 抜粋
- time→config→env、db→env、appContext→db+time
- features→shared/db/time/env/logger
- discord/shared→features (逆方向)
- scheduler→features、index→全部

## 循環 (madge --circular)
1. discord/shared/dispatcher.ts ↔ features/ask-session/button.ts
2. dispatcher ↔ ask-session/command.ts
3. dispatcher ↔ cancel-week/button.ts
4. dispatcher ↔ postpone-voting/button.ts

## Feature 間 cross-import
- ask-session → postpone-voting/reminder/decided-announcement (settle.ts:7,9,13,14)
- postpone-voting → ask-session (settle.ts:19)
- cancel-week → ask-session/postpone-voting (settle.ts:7,11,12)

## shared→feature 逆参照
- discord/shared/dispatcher.ts:10,14-19; guards.ts:14 → interaction-reject + 3 features
- db/time → feature 逆参照は **なし** (健全)

## Findings
### F1: shared↔feature 双方向依存 [Medium]
- dispatcher/guards が feature 参照、feature が InteractionHandlerDeps を dispatcher から受ける
- TA7 F1 を dep graph 側から追認

### F2: ファイル単位循環 4 件 [Medium]
- すべて dispatcher.ts 起点
- 推奨: InteractionHandlerDeps を discord/shared → ports/types に切り出し

### F3: repositories→features 逆方向なし [Low, 健全]

### F4: deep import (features/*/internal) なし [Low, 健全]

### F5: logger/env/config 広く横断 [Low, 健全]
- logger ~19 / env ~14 / config ~5 ファイル

## TA7 との整合
- TA7 F1 (shared↔feature 双方向) を追認
- madge 実測で循環 4 件を数値化
- 独立観点で一致、R8 統合時 Medium 確定素材
