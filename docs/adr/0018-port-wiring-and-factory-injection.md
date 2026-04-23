---
adr: 0018
title: ポート境界と factory 注入によるテスト可能な合成
status: accepted
date: 2026-04-24
supersedes: []
superseded-by: null
tags: [runtime, testing, docs]
---

# ADR-0018: ポート境界と factory 注入によるテスト可能な合成

## TL;DR
DI コンテナは使わず軽量 factory 注入を採用する。`src/ports/` に `SessionsPort` / `ResponsesPort` / `MembersPort` 等の interface を定義し、production は `makeRealPorts(db)`、テストは `createTestAppContext({ seed, now })` の Fake ports を使う。handler/scheduler は `AppContext` を受け取り `ctx.ports.*` / `ctx.clock` のみに依存。repository への `vi.mock` は禁止。

## Context
テスト時の interface drift と依存グラフの可視性に課題がある。

- **module-level import + `vi.mock` 戦略**: handler / scheduler / settle が `src/db/repositories/*.ts` を直接 import し、テストは `vi.mock("../../src/db/repositories/...")` で concrete module をモック。
- **interface drift が silent**: repository 関数 signature が変わっても（例: `findSessionById` に引数追加）既存の mock が古いまま残り、テストは新 signature を検証せずパスし続ける。
- **依存グラフが構造から読み取りにくい**: 各 handler が独立に `db` / `systemClock` / repository functions を引き込み、全体が分散記述される。
- **DI コンテナ（inversify / tsyringe / awilix）は本規模に過剰**（ADR-0017 と整合）。decorator / string token / container 登録の overhead は 1500 LOC に見合わない。

vi.mock の脆弱性を compile 時に型で検出でき、かつ DI コンテナを使わずに済む軽量な合成戦略が必要。

## Decision
**軽量 factory 注入**を採用。DI コンテナ（inversify / tsyringe / awilix）は不採用（ADR-0017 と整合）。

### Port 境界
- **`src/ports/index.ts` に port interface を定義**し DB 具体 API を隠蔽。`AppPorts = { sessions: SessionsPort; responses: ResponsesPort; members: MembersPort; ... }`（readonly）。@see `src/ports/index.ts`
- **Production**: `src/ports/real.ts` の `makeRealPorts(db)` が `db` を closure で保持して実装を返す。
- **Test**: `tests/testing/ports.ts` の `createTestAppContext({ seed, now })` が Fake ports を返す。`FakeSessionsPort implements SessionsPort` の**型制約で interface drift を compile 時検出**する（vi.mock の silent 失敗を排除）。

### 合成点（AppContext）
- **唯一の合成ポイント = `src/appContext.ts`**。`AppContext = { readonly ports: AppPorts; readonly clock: Clock }`。
- production は `src/index.ts` の `createAppContext()`、test は `createTestAppContext()`。両者が**同じ `AppContext` shape を共有**し、差分は ports / clock 実装のみに局所化する。

### Handler / Scheduler / Workflow 契約
- **handler / scheduler / workflow / settle は `AppContext` を受領**し `ctx.ports.*` / `ctx.clock` のみに依存する。**`src/db/repositories/*` / `src/db/client` の直接 import 禁止**。
- 新 port / method 追加手順: `src/ports/index.ts` に interface 追加 → `AppPorts` 組込 → `real.ts` 実装 → `tests/testing/ports.ts` で Fake 実装（`implements` 必須）→ caller は `ctx.ports.*` で利用。

### Fake ports の semantics
`FakeSessionsPort` は production と同粒度で DB 制約を模倣: **CAS / unique `(weekKey, postponeCount)` / unique `(sessionId, memberId)` / 状態遷移ルール**。任意前提状態は seed data で組み立て可能とする。

### Clock invariants
`createFakeSessionsPort` / `createFakeHeldEventsPort` 等は `AppContext.clock` を受け取り、`updatedAt` / `createdAt` 等で **`new Date()` 直呼びを使わない**。`now` 固定 ctx でポート内部の時刻が完全に再現可能になる（決定論的テスト）。

### Test 禁止事項
- **`vi.mock` on `src/db/repositories/*` / `src/db/client` を新規テストに書かない**。Fake ports + seed に置き換える。
- 既存 vi.mock は renderer（`render*.ts`）等 port 境界外に限定し、段階的に Fake ports へ移行。`src/db/schema.ts` のような純粋定数は vi.mock せず実 import を使う。
- Test fakes は `tests/testing/` に集約。個別テストファイルに inline fake を書かない。

## Consequences

### Follow-up obligations
- 新規 handler / scheduler / workflow は module-level で `src/db/repositories/*` / `src/db/client` を import せず、`AppContext` を受領して `ctx.ports.*` / `ctx.clock` のみに依存する。
- 新 port / method 追加は「`src/ports/index.ts` に interface → `AppPorts` 組込 → `src/ports/real.ts` 実装 → `tests/testing/ports.ts` で Fake 実装（`implements` 必須）→ caller を `ctx.ports.*` に切替」の順で行う。
- 既存 `vi.mock` on repositories / db / client は段階的に Fake ports へ移行する。移行期間中は port 境界外（renderer `render*.ts` 等）のみ残す。

### Operational invariants & footguns
- **`vi.mock` on `src/db/repositories/*` / `src/db/client` を新規テストに書かない**。Fake ports + seed に置き換える（interface drift の silent 失敗を防ぐ核心）。
- **Fake ports は production と同粒度で DB 制約を模倣する**: CAS / unique `(weekKey, postponeCount)` / unique `(sessionId, memberId)` / 状態遷移ルール。劣化 Fake は production との乖離テスト事故源。
- **Fake ports 内で `new Date()` 直呼び禁止**。`AppContext.clock` を受領し `updatedAt` / `createdAt` 等に使う（`now` 固定 ctx で決定論的に再現可能にする）。
- **Test fakes は `tests/testing/` に集約**。個別テストファイルに inline fake を書かない（再利用と drift 検知を損なう）。
- `src/db/schema.ts` 等の純粋定数モジュールは `vi.mock` せず実 import を使う（副作用なし、DB 接続不要）。
- port interface 変更時は production / real port / fake port / caller を同時に変える必要がある（TypeScript が強制）。変更量増加を受容して型安全性を買う trade-off。

## Alternatives considered

- **A: DI コンテナ（inversify / tsyringe / awilix）** — decorator metadata / string token / container 登録の overhead が 4 名固定個人開発規模に見合わず、interface + factory + closure で十分。
  - 再評価トリガ: 依存グラフが深化し手動配線が破綻する規模（handler 数 20+ / service 層追加）。
- **B: Module-level import + vi.mock 継続** — interface drift が silent になる問題を解決せず、module 変更で既存 mock が無効化される状況を検出できない。
- **C: effect-ts の Context / Layer** — ADR-0017 で既に却下。同等以上の記述量で runtime 依存と学習曲線の便益が無い。
- **D: Settle を `src/workflow/` に移動する structural refactor** — 1500 LOC 規模では新ディレクトリ churn が readability 向上を上回らず、orchestration 責務は ADR-0001 / ADR-0015 の組合せで既に明示。
  - 再評価トリガ: orchestration ファイルが 3 つ以上、discord 以外の entry point が追加される。

## Operational implications

### 新 port / 新 repository method の追加手順
1. `src/ports/index.ts` に interface を追加 → `AppPorts` に組み込み。
2. `src/ports/real.ts` で production 実装を追加。
3. `tests/testing/ports.ts` で fake 実装を追加し `FakeXxxPort implements XxxPort` で型チェック。
4. caller は `ctx.ports.*` 経由で使用。

### 既存 vi.mock の扱い
- `vi.mock` on `src/db/repositories/...` / `src/db/client` は**新規テストに書かない**。
- 既存テストで残る vi.mock は renderer（`render*.ts`）・feature settle 関数など、port 境界外のものに限定。段階的に Fake ports へ移行。
- `src/db/schema.ts` のような純粋定数モジュールは vi.mock を使わず実 import を使う（副作用がなく DB 接続不要のため）。

### Test seed 設計
Fake ports が DB 相当の重要な property（unique 制約 / CAS semantics / 状態遷移ルール）を再現できるレベルまで実装し、test seed を通じて任意の前提状態をセットアップ可能にする。
