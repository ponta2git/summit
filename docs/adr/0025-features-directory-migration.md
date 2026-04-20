---
adr: 0025
title: feature 単位ディレクトリ（src/features/）への再編
status: accepted
date: 2026-04-25
supersedes: []
superseded-by: null
tags: [runtime, discord, docs]
---

# ADR-0025: feature 単位ディレクトリ（src/features/）への再編

## Context
ADR-0020 で `src/discord/` 配下を「Discord の構造的 layer」で分割した（`ask/`・`postpone/`・`buttons/`・`commands/`・`settle/`）。しかし追加機能（15 分前リマインド / 開催決定メッセージ / `/cancel_week`）を実装する過程で、1 つの業務 feature が 3〜5 ディレクトリに散らばる痛点が顕在化した:

- ask 募集 feature: `discord/ask/` + `discord/buttons/askButton.ts` + `discord/commands/ask.ts` + `discord/settle/ask.ts` の 4 箇所。
- postpone 投票 feature: `discord/postpone/` + `discord/buttons/postponeButton.ts` + `discord/settle/postpone.ts` の 3 箇所。
- reminder feature: `discord/settle/reminder.ts`（他と同じ層に同居）。
- cancel-week feature: `discord/buttons/cancelWeekButton.ts` + `discord/commands/cancelWeek.ts` + `discord/settle/skipWeek.ts` の 3 箇所。

変更の影響範囲把握（grep・IDE 探索）に過度なコストがかかり、未実装機能（#22 decided announcement など）の開発速度低下の主因になっていた。

## Decision
Discord の層別ディレクトリを廃止し、**1 feature = 1 ディレクトリ**の構造に再編する。

```
src/features/
  ask-session/         # render / send / button / command / settle / choiceMap
  postpone-voting/     # render / button / settle
  reminder/            # send
  cancel-week/         # button / command / settle
  decided-announcement/# send（新規）
src/discord/shared/    # customId / guards / viewModels / dispatcher / messages
```

- 共有 Discord infra（dispatcher / guards / customId codec / view-model builders / 共通 render helper）は `src/discord/shared/` に集約する。
- feature 間の直接依存は禁止しない。現状 `reminder` は `ask-session` の slot 情報に依存（薄く）。増えたら feature 横断 service を `src/discord/shared/` に置く。
- barrel（`src/features/*/index.ts`）は作らない。import は名前付きファイル直接参照とし、grep 一発で依存を辿れる状態を保つ（ADR-0020 で述べた barrel 衝突リスクと同趣旨）。

## Consequences
### 得られるもの
- **変更影響の局所化**: 1 feature の仕様変更が基本 1 ディレクトリ内に収まり、AI / 人間の探索コストが下がる。
- **削除容易性**: feature 廃止時にディレクトリ単位で削除できる。
- **naming の明示化**: `discord/settle/ask.ts` の「ask」は募集 feature の意だが、feature ディレクトリ名 `ask-session` の方が業務概念（週次の募集セッション）に近い。

### 失うもの / 運用上の含意
- **import path 変更コスト**: 1 回限り。ADR-0020 で外した barrel 方針を維持したため、test の `vi.mock` は新 path に追随が必要。
- **ADR-0020 との関係**: ADR-0020 の「settle/ ディレクトリ分割」決定（項目 2）は本 ADR の移行により実質的に無効化されるが、同 ADR の他の決定（button handler 重複解消 / 型強化 / 死んだ参照除去）は維持される。0020 は accepted のまま残し、settle/ 分割部分のみ上書きと見なす。
- **feature 横断の共通化の誘惑**: 共通化は `src/discord/shared/` に集約し、feature 相互 import はなるべく避ける。横断ニーズが増えたら該当 service を `shared/` に出す。

## Alternatives considered
- **現状維持（`src/discord/{ask,postpone,buttons,commands,settle}/`）**: 追加機能のたびに 3〜5 箇所 touch する痛点が解消されず、却下。
- **`src/features/*/index.ts` バレル**: 依存方向の grep 追跡が難しくなり、ADR-0020 で退けた barrel と同じ問題を招くため不採用。
- **`src/discord/` 配下のまま feature ディレクトリ化（`src/discord/features/`）**: `discord/` はもはや interaction 受信・配信の shared infra を指す名前に留めたい。feature を Discord プロトコル層の下に隠すのは認知負荷が逆転する。
