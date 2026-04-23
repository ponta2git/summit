---
adr: 0026
title: 境界の再整理（domain 廃止・ports の DB 境界明示・非対称性の追認）
status: accepted
date: 2026-04-25
supersedes: []
superseded-by: null
tags: [runtime, db, discord, docs]
---

# ADR-0026: 境界の再整理（domain 廃止・ports の DB 境界明示・非対称性の追認）

## TL;DR
`src/domain/` を廃止（`slot.ts` は `src/slot.ts` へ、`deadline.ts` / `postpone.ts` は各 feature の `decide.ts` へ移動）。`src/ports/` を `src/db/ports.ts` / `src/db/ports.real.ts` に改名し DB 境界であることを path で明示。Discord は port 化しない非対称（ADR-0017）、`scheduler/` / `members/` / `time/` は infra として features/ に入れないことを追認する。

## Context
ADR-0025 の features/ 移行後、レイヤー配置に以下の疑義が挙がった:

1. `src/ports/` は名称が generic だが実質 DB 境界専用（Discord は未抽象）。
2. `src/domain/` が「ドメインオブジェクトの網羅」ではなく「横断共通語彙 1 個（`slot.ts`）＋ feature 固有の決定関数 2 個（`deadline.ts` / `postpone.ts`）」で layer ラベルと実態が不整合。
3. `scheduler/` / `members/` を features/ に含めない理由、`src/time/` を feature に分散しない理由が未明文化。
4. DB 境界（port 化あり）と Discord 境界（port 化なし）の非対称性への疑問。

ADR-0017（Discord 非抽象化）・ADR-0018（port wiring）・ADR-0002（時刻集約）・ADR-0025（features/ 配置）は存在するが、境界全体の整合を一望する ADR が無く drift 源になっていた。

## Decision

### 採用（構造変更）
- **`src/domain/` を廃止**:
  - `src/domain/slot.ts` → **`src/slot.ts`**（wire format SSoT。customId / DB enum / label mapping の起点。cross-cutting のため `src/` 直下）
  - `src/domain/deadline.ts` → **`src/features/ask-session/decide.ts`**
  - `src/domain/postpone.ts` → **`src/features/postpone-voting/decide.ts`**
- **`src/ports/` → `src/db/ports.ts` / `src/db/ports.real.ts`**（path で DB 境界を明示）。
  - 型名 `AppPorts` / `SessionsPort` / `ResponsesPort` / `MembersPort` は**変更しない**（call-site churn 回避）。
  - `AppContext = { ports, clock }` の外形は維持。

### 追認（構造変更なし、決定を再言明）
- **Discord 境界は抽象化しない**（ADR-0017）。discord.js の rich types を直接扱う。DB 境界のみ port 化するのは **意図的な非対称** であり、本 ADR で追認。
- **`src/scheduler/` / `src/members/` は features/ に移さない**（cron orchestrator / 起動時 env→DB 同期は infra）。
- **`src/time/` は feature に分散しない**（ADR-0002。JST 集約は project-wide invariant、`new Date()` 規制の実効性維持）。
- **`src/shutdown.ts` / `src/index.ts` は `src/` 直下**（bootstrap、`bootstrap/` 新設は abstraction-over-scale）。

### Invariants
- 業務ロジックの配置規則は「**features/ か `src/slot.ts`（wire format のみ）**」の二択。
- ADR-0013（slot SSoT）の path 参照、ADR-0018 の port path 参照は本 ADR で更新される（SSoT / wiring 方針は維持、位置のみ変更）。

## Consequences

### Operational invariants & footguns
- 「業務ロジックは features/ か `src/slot.ts`（wire format のみ）」という単純な規則になり、「domain/ に置くか feature に置くか」の判断コストが消える。
- port の path が境界意図を表すようになり、新規参加者の学習コストが下がる。
- 非対称性（DB port 化 / Discord 直使用）と infra（scheduler/members/time/shutdown/index）の配置根拠が単一 ADR から辿れるようになる。
- ADR-0013（`src/domain/slots.ts` を slot SSoT とする）の path は本 ADR で更新される（SSoT 自体は維持、位置のみ変更）。
- ADR-0018 の path 参照（`src/ports/*`）は本 ADR で更新される。`AppPorts` の型名・合成方法は維持。

## Alternatives considered
- **ports を `infra/` に置く** — infra/ 新設で members / scheduler / db の境界が曖昧になる、ports は DB 境界専用なので `db/` 配下が最短。却下。
- **scheduler / members を features/ 化** — user-facing feature という意味が希薄化し分類ラベルとして機能しなくなる。却下。
- **Discord も port 化して対称にする** — ADR-0017 で却下済み、testability は cron/DB 側で吸収できる。
- **decide 関数を `src/domain/` に残す** — cross-cutting でなく feature 固有で locality が低下するため feature に戻す。却下。
- **`src/slot.ts` を features 配下に置く** — customId codec / DB enum / 3 feature が同時依存する wire format で、feature 配下は dependency inversion を起こす。却下。

## References
- @see [ADR-0002](./0002-jst-fixed-time-handling.md) 時刻集約の原則
- @see [ADR-0013](./0013-config-layering.md) slot SSoT の原則（path は本 ADR で更新）
- @see [ADR-0017](./0017-rejected-architecture-alternatives.md) Discord 非抽象化
- @see [ADR-0018](./0018-port-wiring-and-factory-injection.md) port wiring（path は本 ADR で更新）
- @see [ADR-0025](./0025-features-directory-migration.md) features/ 配置
