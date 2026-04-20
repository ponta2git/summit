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

## Context
ADR-0025 の features/ 移行後、レイヤー配置について次の疑義が挙がった：

1. `src/ports/` は名称上 generic だが、実質は DB 境界のみを抽象化している（Discord は未抽象）。
2. `src/domain/` に `slot.ts` / `deadline.ts` / `postpone.ts` を置いているが、これらは「ドメインオブジェクトの網羅」ではなく「feature 横断の共通語彙 1 個（Slot）＋ feature 固有の決定関数 2 個」である。domain 層と呼ぶには不整合。
3. `scheduler/` や `members/` を features/ に含めない理由、`src/time/` を feature に分散しない理由が明文化されていない。
4. DB 境界（port 化あり）と Discord 境界（port 化なし、discord.js 直接利用）の扱いが非対称であることへの疑問。

ADR-0017（Discord 非抽象化の追認）・ADR-0018（port wiring）・ADR-0002（時刻処理集約）・ADR-0025（features/ 配置）は既に存在するが、境界全体の整合を一望する ADR が無いため drift 源になっていた。

## Decision
### 採用（構造変更を行う）
- **`src/domain/` を廃止する**。
  - `src/domain/slot.ts` → **`src/slot.ts`**（wire format SSoT。customId / DB enum / label mapping の起点。cross-cutting なため `src/` 直下に単独モジュールとして置く）。
  - `src/domain/deadline.ts` → **`src/features/ask-session/decide.ts`**（ask セッション固有の締切判定）。
  - `src/domain/postpone.ts` → **`src/features/postpone-voting/decide.ts`**（順延投票固有の判定）。
  - feature-local な決定関数は feature ディレクトリに戻し、「どこに置いたか」を「どの feature のロジックか」で辿れるようにする。
- **`src/ports/` を `src/db/ports.ts` / `src/db/ports.real.ts` に改名移設する**。
  - ports は実質 DB 境界の契約であることを path で明示する。
  - `AppPorts` / `SessionsPort` / `ResponsesPort` / `MembersPort` の型名は変更しない（call-site churn 回避）。
  - `AppContext = { ports, clock }` の外形は維持。

### 追認（構造変更は行わず、決定を再言明する）
- **Discord 境界は引き続き抽象化しない**（ADR-0017）。discord.js の rich types を直接扱う方がシンプルで、Fake の利益が薄い。DB 境界は testability の核であり port 化の利益が高い。**この非対称は意図的**であり、本 ADR で追認する。
- **`src/scheduler/` と `src/members/` は features/ に移さない**。これらは user-facing feature ではなく、cron orchestrator / 起動時 env→DB 同期という infra に属する。features/ 概念を infra まで薄めると分類が無意味化する。
- **`src/time/` は feature に分散しない**（ADR-0002）。JST 集約は drift 源を減らすための project-wide invariant であり、feature に散らすと `new Date()` 規制の実効性が失われる。
- **`src/shutdown.ts` / `src/index.ts` は `src/` 直下に置く**。bot bootstrap であり、2701 LOC 規模で `bootstrap/` サブディレクトリは abstraction-over-scale。

## Consequences
- 「業務ロジックは features/ か `src/slot.ts`（wire format のみ）」という単純な規則になり、「domain/ に置くか feature に置くか」の判断コストが消える。
- port の path が境界意図を表すようになり、新規参加者の学習コストが下がる。
- 非対称性（DB port 化 / Discord 直使用）と infra（scheduler/members/time/shutdown/index）の配置根拠が単一 ADR から辿れるようになる。
- ADR-0013（`src/domain/slots.ts` を slot SSoT とする）の path は本 ADR で更新される（SSoT 自体は維持、位置のみ変更）。
- ADR-0018 の path 参照（`src/ports/*`）は本 ADR で更新される。`AppPorts` の型名・合成方法は維持。

## Alternatives considered
- **ports を `infra/` に置く**: 却下。infra/ を新設すると members/ scheduler/ db/ の境界が曖昧になる。ports は DB 境界専用なので `db/` 配下が最短の意図表明。
- **scheduler/members を features/ 化**: 却下。user-facing feature という feature/ の意味が希薄化し、「すべてが feature」になると分類ラベルとして機能しなくなる。
- **Discord も port 化して対称にする**: ADR-0017 で却下済み。discord.js の型（`ButtonInteraction` 等）を自前で再定義する cost に対し、Discord 側で testability を要する箇所は cron/DB 側で既に吸収できている。
- **decide 関数を `src/domain/` に残す**: 却下。cross-cutting でなく feature 固有のため、feature に戻す方が locality が高い。ask-session 固有の締切ロジックを postpone-voting から参照することはない。
- **`src/slot.ts` を features 配下のどこかに置く**: 却下。customId codec / DB enum / 3 feature が同時に依存する wire format なので feature 配下は dependency inversion を起こす。

## References
- @see [ADR-0002](./0002-jst-fixed-time-handling.md) 時刻集約の原則
- @see [ADR-0013](./0013-config-layering.md) slot SSoT の原則（path は本 ADR で更新）
- @see [ADR-0017](./0017-rejected-architecture-alternatives.md) Discord 非抽象化
- @see [ADR-0018](./0018-port-wiring-and-factory-injection.md) port wiring（path は本 ADR で更新）
- @see [ADR-0025](./0025-features-directory-migration.md) features/ 配置
