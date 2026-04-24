---
adr: 0037
title: feature locality 優先と cross-cutting 抽出基準の明示化
status: accepted
date: 2026-04-24
supersedes: []
superseded-by: null
tags: [runtime, discord, docs]
---

# ADR-0037: feature locality 優先と cross-cutting 抽出基準の明示化

## TL;DR
`src/features/` は「1 ディレクトリ = 1 機能」の可視性を `src/discord/shared/` への抽出より優先する。ファイルサイズや LOC の小ささは `src/features/<feat>/` から `src/discord/shared/` へ昇格させる十分条件にしない。feature 間 import は ADR-0028 の pure-only 原則を維持し、残存する副作用 feature→feature import は **orchestrator 層**（scheduler 側に寄せる / 上位の呼び出し責務統合）で解消する。

## Context

ADR-0027 / ADR-0028 で `src/discord/shared/` を「真 cross-cutting のみ」に限定する方針を定めた後、2026-04-24 の 15 軸品質評価（`docs/reviews/2026-04-24/`）で以下の提案が出た:

1. `src/features/interaction-reject/messages.ts` は 1 ファイル（文言定数のみ）で 4 feature + dispatcher + guards から参照される。構造的には真の cross-cutting 資材であり、`src/discord/shared/rejectMessages.ts` に移動すれば feature→feature pair が 9 → 5 に減る（`04-coupling-paths.md`）。
2. 残存する feature 間副作用 import 5 pair は ADR-0028 の pure-only 原則と drift しており解消が必要（`14-uniformity.md`）。

1. について試験実装（commit 82f9e42）を行ったが revert した。理由は次の判断:

- `src/features/` を俯瞰した読み手が「どの機能が存在するか」を即把握できる可視性（feature locality）は、1 ファイル程度の cross-cutting 最適化より価値が高い。
- `interaction-reject` は UI コピーを持つ独立機能（interaction 拒否時のユーザー可視文言を決める責務）であり、constants.ts だけに見えても概念単位としては 1 feature。
- ADR-0027 の「真 cross-cutting のみ shared」は **責務が横断しているか** を基準にする。ファイル数・LOC の少なさを根拠に格上げすると shared の定義が「便利置き場」へ緩む（ADR-0027 で棄却された代替案と同型）。

2. については、resolution の方向が「shared への抽出」ではないことを明示する必要があった。`src/features/<feat>/settle.ts` が他 feature の `send.ts` / `viewModel.ts`（pure）を呼ぶ現状は、抽出ではなく **呼び出し責務の上位化**（scheduler / orchestrator 層が順序を駆動する）で解くべき問題。

## Decision

### 1. feature locality 優先原則

`src/features/<feat>/` から `src/discord/shared/` への昇格は以下を**同時に**満たす場合のみ行う:

- **責務が cross-cutting**: 特定機能ではなく、interaction の入口 / 出口 / DB decouple 契約 / インフラ薄ラッパのいずれか（ADR-0027 / ADR-0028 の既存基準）。
- **feature ディレクトリの可視性を損なわない**: 昇格後も `src/features/` を俯瞰したとき既存機能が機能として読み取れる。言い換えると「1 feature 丸ごと消える」昇格は行わない。

ファイル数・LOC の小ささ、参照元 feature 数の多さは**単独では**昇格根拠にならない。

### 2. 既存配置の追認

`src/features/interaction-reject/` は 1 ファイル（`messages.ts`）構成のまま feature として維持する。interaction 拒否文言は「1 機能の資材」として扱う。

### 3. feature 間 import の整理方針（orchestrator 寄せ）

ADR-0028 の pure-only 原則を維持しつつ、**副作用を伴う feature 間 import は shared 抽出ではなく上位層の責務統合で解消する**:

- 既存の副作用 feature→feature import は `scheduler/` か新たな orchestrator 相当の層から順序を駆動する形へ段階的に再配線する。
- 抽出先の ownership は scheduler 側（`src/scheduler/`）に置くことを優先する。`src/discord/shared/` に副作用を持ち込む格上げは行わない。
- pure 型 + pure builder + 定数のみの feature 間 import は引き続き許容（ADR-0028）。

## Consequences

### Follow-up obligations

- 現時点では構造変更を伴わない決定。残存する副作用 feature→feature import の具体的な再配線は別 ADR / PR で扱う（`docs/reviews/2026-04-24/04-coupling-paths.md` の改善提案に対応）。
- `docs/reviews/2026-04-24/` の 14 / 10 / 11 軸における「ADR-0028 と実装の drift」記述は、本 ADR で方針化されたため drift ではなく「orchestrator 層で解消予定の既知項目」として扱う。

### Operational invariants & footguns

- feature 追加時、「小さな feature だから shared へ」という判断を反射的に行わない。1 ファイル feature も 1 機能として許容する。
- `src/discord/shared/` への追加は責務 cross-cutting 基準（ADR-0027 / ADR-0028）に加え本 ADR の locality 基準も満たすか確認する。
- 本 ADR は ADR-0027 / ADR-0028 の decision を改変しない。配置基準の優先順位を明文化し、曖昧だった「1 ファイル constants の feature」判断を確定させる性質。

## Alternatives considered

- **interaction-reject を `src/discord/shared/rejectMessages.ts` へ移動する** — feature→feature pair 4 本削減の効果はあるが、`src/features/` の俯瞰性を失い「interaction-reject が 1 機能」の事実が暗黙化する。ファイルサイズを根拠に shared へ昇格させると「便利置き場」化（ADR-0027 で棄却された代替案と同型）のため却下。
- **ADR-0028 の pure-only を緩めて副作用 feature→feature import を許容する** — 「feature の ownership が描画と副作用の両方を持つ」という ADR-0028 の前提と衝突し、変更波及予測が難しくなるため却下。
- **副作用 feature→feature import を shared に抽出する** — shared が「feature の副作用ハブ」になり責務定義が崩壊するため却下（ADR-0027 / ADR-0028 の基準違反）。
- **ADR-0027 を supersede して feature locality 基準を書き直す** — ADR-0027 の Decision 本体は現状維持（interaction-reject は features/ に置く、が元々の決定）。本 ADR は基準の優先順位を明文化するだけで方針転換ではないため、supersede ではなく追補で十分。

## Re-evaluation triggers

- 1 ファイル constants の feature が 3 つ以上並び、かつ各 feature がそれ以上成長する見込みがない場合 → feature locality を保ったまま集約する枠組み（例: `src/features/_shared-copy/` のような feature-group）を検討する。
- orchestrator 層を導入しても副作用 feature→feature import が 3 pair 以上残る場合 → import 方向そのものの設計前提を再検討する。
- `src/features/` 配下が 12 feature を超える規模に成長した場合 → locality より navigation の効率が優位になる可能性があり、shared 抽出基準を見直す。

## Links

- `src/features/interaction-reject/messages.ts`
- `src/discord/shared/` （ADR-0027 / ADR-0028 が定義する境界）
- `docs/reviews/2026-04-24/04-coupling-paths.md`
- `docs/reviews/2026-04-24/14-uniformity.md`
- `docs/reviews/2026-04-24/final-report.md`
- ADR-0025, ADR-0026, ADR-0027, ADR-0028
