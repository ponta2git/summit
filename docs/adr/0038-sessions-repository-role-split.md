---
adr: 0038
title: sessions repository を role-based で分割する
status: accepted
date: 2026-04-24
supersedes: []
superseded-by: null
tags: [db, docs]
---

# ADR-0038: sessions repository を role-based で分割する

## TL;DR

`src/db/repositories/sessions.ts`（596 行 / 24 関数 export）を role 単位で 7 ファイルに分割し、`sessions.ts` は named re-export のみの barrel に退化させる。stage-based（asking/postpone/decided）分割は代替案として却下。public surface 24 名は barrel 維持で保護し、`src/db/ports.real.ts` とテストは無修正で pass する。内部 helper は barrel 非露出で隔離する。

## Context

2026-04-24 の 15 軸品質評価（`docs/reviews/2026-04-24/`）で `03-module-cohesion.md` の H-1 として、`src/db/repositories/sessions.ts` が 596 行 / 24 関数 export / 4 責務（construction・CAS transitions・reminder claim・queries）を同居させており、変更集中点かつ LCOM が構造的に高い状態が指摘された。単一ファイルである限り新規 CAS の追加レビューは毎回 596 行全体に及び、ADR-0024 の reminder claim invariant も file 全体に埋没する。

Summit は個人開発規模 (ADR-0005) + 固定 4 名 + 単一インスタンス運用であり、過剰な層は不要（ADR-0017 で "個別ファイル 300 行を advisory 閾値として超過時のみ分割検討" を合意済）。今回のケースは当該 advisory を明確に超えており、かつ 4 責務が独立した invariant と race 特性を持つため、分割の正当化根拠がそろっている。

03-cohesion.md の提案本文では "stage-based" と記述されつつ、具体ファイル名は `sessions.transitions.ts` 等の role 指向で示されており、wording と具体例が整合していなかった。本 ADR でこの不整合を確定させる。

## Decision

`src/db/repositories/sessions/` は作らず、既存の `src/db/repositories/` 直下に `sessions.*.ts` サフィックス命名で role ごとに分割する:

| file | 責務 |
|---|---|
| `sessions.ts` | **barrel**。public API 24 名を named re-export のみ。実装コードを持たない |
| `sessions.internal.ts` | `mapSession` / `runEdgeUpdate` / `NON_TERMINAL_STATUSES` / `assertNever`。**barrel からは re-export しない**（external 露出禁止） |
| `sessions.types.ts` | `CreateAskSessionInput` および CAS 系 input interface 6 種 |
| `sessions.create.ts` | `createAskSession` / `updateAskMessageId` / `updatePostponeMessageId` / `backfillAskMessageId` / `backfillPostponeMessageId` |
| `sessions.transitions.ts` | `cancelAsking` / `startPostponeVoting` / `completePostponeVoting` / `decideAsking` / `completeCancelledSession` / `completeSession` / `skipSession` |
| `sessions.reminder.ts` | `claimReminderDispatch` / `revertReminderClaim`（ADR-0024 固有の race / idempotent TSDoc をそのまま保存） |
| `sessions.queries.ts` | `find*` 9 種 |
| `sessions.predicates.ts` | `isNonTerminal` |

barrel は `export *` を用いず named list で re-export し、internal helper の漏出を静的保証する。

## Consequences

- public surface 24 名は barrel 経由で不変。`src/db/ports.real.ts` / `tests/integration/*.contract.test.ts` / `tests/ports/sessions.test.ts` など既存 import 元は無修正で pass する。
- `docs/reviews/2026-04-24/03-module-cohesion.md` H-1 / `11-modifiability.md` H-1 / `14-uniformity.md` file-size advisory の 1 件が解消対象になる。
- 新規 CAS の追加点は `sessions.transitions.ts` のみ。新規 query は `sessions.queries.ts`。レビュー範囲が role ごとに局所化される。
- `runEdgeUpdate` helper は `sessions.internal.ts` に集約され、`sessions.transitions.ts` のみが名前 import。ジェネリック型 `AllowedNextStatus<S>` は `ports.ts` 由来で両ファイルから独立に import 可。
- `sessions.reminder.ts` は ADR-0024 の claim-first / revert invariant を単独ファイルで可視化し、reconciler 改修時の読解コストを下げる。
- 過渡期の妥協なし。pure code motion + barrel 化のみで、振る舞いと DB スキーマは完全不変。

## Alternatives considered

- **stage-based 分割（asking / postpone / decided / common）** — 却下。`findSessionById` / `isNonTerminal` / `createAskSession` のような stage 横断資材の置き場が曖昧になる。`src/db/ports.ts` のメソッド名（`cancelAsking` / `decideAsking` 等）で stage 概念は既に表現済であり、実装層側で stage を再表現すると重複する。
- **現状維持** — 却下。ADR-0017 の advisory 閾値を明確に超え、新規 CAS のレビュー範囲が 596 行全体に固定され続ける。
- **`src/db/repositories/sessions/` ディレクトリ化 + `index.ts` 置換** — 却下。既存の `repositories/` は flat 構成で、outbox/responses/members/heldEvents もすべて単一ファイル直下に置かれている。ディレクトリ化は他 repository との統一性を崩す。サフィックス命名 `sessions.<role>.ts` なら既存慣習を維持しつつ役割可視化できる。

## Re-evaluation triggers

- `sessions.transitions.ts` が再度 300 行を超過したとき（新 CAS 系統が増え、stage 別・outcome 別などのサブ分割を再検討）。
- Stage 横断フロー（例: 金曜→土曜の saturday re-ask）を実装レイヤで可視化したくなったとき。その場合は本 ADR の stage-based 却下理由を再評価する。
- `repositories/` 配下の他ファイル（`responses.ts` / `outbox.ts` 等）が同じ advisory を超えたとき。命名戦略（`<repo>.<role>.ts` vs ディレクトリ化）を本 ADR を基準に再確認する。

## Links

- `@see ADR-0017` — 個別ファイル 300 行の advisory 閾値
- `@see ADR-0018` — port wiring / 実装層の位置づけ
- `@see ADR-0022` — SSoT taxonomy（barrel の責務範囲）
- `@see ADR-0024` — reminder claim invariant（`sessions.reminder.ts` の存在理由）
- `@see ADR-0035` — discord-send outbox（`runEdgeUpdate` の outbox enqueue）
- `@see ADR-0037` — feature locality。本 ADR は repositories 層の話で適用対象外だが、"小さい理由で分割／統合しない" の原則は共有する
- `@see docs/reviews/2026-04-24/03-module-cohesion.md` — 分割根拠
