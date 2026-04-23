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

## TL;DR
Discord の構造的 layer 分割（ADR-0020）を廃止し、**1 feature = 1 ディレクトリ**に再編する（`src/features/ask-session/` / `postpone-voting/` / `reminder/` / `cancel-week/` / `decided-announcement/`）。共有 Discord infra は `src/discord/shared/` に集約。barrel は作らず直接 import で依存を grep 可能にする。

## Context
ADR-0020 で `src/discord/` を構造的 layer（`ask/`・`postpone/`・`buttons/`・`commands/`・`settle/`）に分割した結果、追加機能実装時に 1 feature が 3〜5 ディレクトリに散らばる痛点が顕在化した（パス名は driver として保持）:

- ask 募集: `discord/ask/` + `buttons/askButton.ts` + `commands/ask.ts` + `settle/ask.ts` の 4 箇所。
- postpone 投票: `discord/postpone/` + `buttons/postponeButton.ts` + `settle/postpone.ts` の 3 箇所。
- reminder: `discord/settle/reminder.ts`（無関係な層に同居）。
- cancel-week: `buttons/cancelWeekButton.ts` + `commands/cancelWeek.ts` + `settle/skipWeek.ts` の 3 箇所。

変更影響範囲の grep・IDE 探索コストが増大し、未実装機能（#22 decided announcement 等）の開発速度低下の主因になっていた。

## Decision
Discord の層別ディレクトリを廃止し、**1 feature = 1 ディレクトリ**に再編する。

### 配置
```
src/features/
  ask-session/         # render / send / button / command / settle / choiceMap
  postpone-voting/     # render / button / settle
  reminder/            # send
  cancel-week/         # button / command / settle
  decided-announcement/# send（新規）
src/discord/shared/    # customId / guards / viewModels / dispatcher / messages
```

### Invariants
- **共有 Discord infra**（dispatcher / guards / customId codec / view-model builders / 共通 render helper）は `src/discord/shared/` に集約。
- **barrel 禁止**（`src/features/*/index.ts` を作らない）。import は名前付きファイル直接参照とし、grep 一発で依存を辿れる状態を保つ（ADR-0020 の barrel 衝突リスクと同趣旨）。
- **feature 間の直接依存は許容するが最小化**。横断ニーズが増えたら service を `src/discord/shared/` へ引き上げる。
- **ADR-0020 の settle/ 分割決定（項目 2）は本 ADR で実質無効化**。他の決定（button handler 重複解消 / 型強化 / 死んだ参照除去）は維持。0020 は accepted のまま残す。

## Consequences

### Follow-up obligations
- **import path 変更コスト**: 1 回限り。ADR-0020 で外した barrel 方針を維持したため、test の `vi.mock` は新 path に追随が必要。

### Operational invariants & footguns
- **変更影響の局所化**: 1 feature の仕様変更が基本 1 ディレクトリ内に収まり、AI / 人間の探索コストが下がる。
- **削除容易性**: feature 廃止時にディレクトリ単位で削除できる。
- **naming の明示化**: `discord/settle/ask.ts` の「ask」は募集 feature の意だが、feature ディレクトリ名 `ask-session` の方が業務概念（週次の募集セッション）に近い。
- **ADR-0020 との関係**: ADR-0020 の「settle/ ディレクトリ分割」決定（項目 2）は本 ADR の移行により実質的に無効化されるが、同 ADR の他の決定（button handler 重複解消 / 型強化 / 死んだ参照除去）は維持される。0020 は accepted のまま残し、settle/ 分割部分のみ上書きと見なす。
- **feature 横断の共通化の誘惑**: 共通化は `src/discord/shared/` に集約し、feature 相互 import はなるべく避ける。横断ニーズが増えたら該当 service を `shared/` に出す。

## Alternatives considered
- **現状維持（`src/discord/{ask,postpone,buttons,commands,settle}/`）** — 追加機能ごとに 3〜5 箇所 touch する痛点が解消されず却下。
- **`src/features/*/index.ts` バレル** — 依存方向の grep 追跡が難しくなり、ADR-0020 で退けた barrel と同じ問題を招くため不採用。
- **`src/discord/features/` として Discord 配下に feature ディレクトリ化** — `discord/` は interaction 受信・配信の shared infra 名に留めたく、feature を下に隠すと認知負荷が逆転。
