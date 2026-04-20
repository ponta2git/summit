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

## Context
テスト時の interface drift と依存関係の可視性に課題がある。

- **従来の module-level import 戦略**: handler / scheduler / settle が `src/db/repositories/*.ts` を直接 import し、テストは `vi.mock("../../src/db/repositories/...")` で concrete module をモック。
- **interface drift の危険性**: repository 関数の signature が変わる（例: `findSessionById` に引数追加）と、既存の mock が silent に古い interface のまま残り、テストが新 signature を検証しないまま動き続ける。
- **依存関係が構造から読み取りにくい**: 各 handler が独立に `db` / `systemClock` / repository functions を引き込むので、全体の依存グラフが分散して記述されている。
- **ユーザー観点の懸念**:
  1. vi.mock の脆弱性：変更に弱い。
  2. DI コンテナ導入の正当性：本当に必要か（ADR-0017 で effect-ts / inversify は却下済み）。
  3. 依存関係の把握：構造から読めるようにしたい。

DI コンテナ（inversify / tsyringe / awilix）は 1500 LOC 規模には過剰（ADR-0017 と整合）。軽量な factory 注入で十分。

## Decision
**軽量 factory 注入** を採用し、DI コンテナは不採用。

### Ports interface 定義（隠蔽層）
`src/ports/index.ts` に port interface を定義し、DB の具体 API を隠蔽する：

```ts
// src/ports/index.ts（抜粋）
export interface SessionsPort {
  findSessionById(id: string): Promise<SessionRow | undefined>;
  findDueAskingSessions(now: Date): Promise<SessionRow[]>;
  transitionStatus(input: TransitionInput): Promise<SessionRow | undefined>;
  // ... createAskSession / updateAskMessageId / 他
}

export interface ResponsesPort {
  listResponses(sessionId: string): Promise<ResponseRow[]>;
  upsertResponse(input: UpsertResponseInput): Promise<ResponseRow>;
}

export interface MembersPort {
  listMembers(): Promise<MemberRow[]>;
  findMemberIdByUserId(userId: string): Promise<string | undefined>;
}

export interface AppPorts {
  readonly sessions: SessionsPort;
  readonly responses: ResponsesPort;
  readonly members: MembersPort;
}
```

### Production 実装（closure で API 保持）
`src/ports/real.ts` の `makeRealPorts(db)` が production 実装を closure で保持：

```ts
// src/ports/real.ts
export function makeRealPorts(db: Database): AppPorts {
  return {
    sessions: {
      async findSessionByWeekKeyAndPostponeCount(weekKey, postponeCount) {
        return db.query.sessions.findFirst({ where: ... });
      },
      // ... 実装
    },
    responses: { /* ... */ },
    members: { /* ... */ },
  };
}
```

### 合成点（AppContext）
`src/composition.ts` で唯一の合成ポイント：

```ts
// src/composition.ts
export interface AppContext {
  readonly ports: AppPorts;
  readonly clock: Clock;
}

export const createAppContext = (overrides: AppContextOverrides = {}): AppContext => ({
  ports: overrides.ports ?? makeRealPorts(defaultDb),
  clock: overrides.clock ?? systemClock
});
```

### Test 合成（Fake ports + seed data）
`tests/testing/ports.ts` で同じ shape の test context を組み立て：

```ts
// tests/testing/ports.ts
export const createTestAppContext = (options: {
  readonly seed?: FakePortsSeed;
  readonly now?: Date | (() => Date);
} = {}): TestAppContext => ({
  ports: createFakePorts(options.seed ?? {}),
  clock: { now: typeof options.now === "function" ? options.now : () => options.now ?? new Date() }
});
```

`FakeSessionsPort` は production と同じ粒度で semantics を模倣（CAS / unique 制約 `(weekKey, postponeCount)` / unique 制約 `(sessionId, memberId)`）。

### Handler / Scheduler / Settle の書き換え
以前：
```ts
// ❌ 直接 import
import { findSessionById } from "../../db/repositories/sessions";
```

以降：
```ts
// ✅ port 経由
async function handleInteraction(interaction: Interaction, ctx: AppContext) {
  const session = await ctx.ports.sessions.findSessionById(sessionId);
}
```

### Test の書き換え
以前：
```ts
// ❌ vi.mock
vi.mock("../../db/repositories/sessions", () => ({
  findSessionById: vi.fn(async (id) => mockSession),
}));
```

以降：
```ts
// ✅ Fake ports + seed
const ctx = createTestAppContext({ seed: { sessions: [mockSession] } });
// test は ctx.ports.* 経由で Fake ports を使う
```

## Consequences

### 得られるもの
- **Interface drift 検出**: `FakeSessionsPort implements SessionsPort` の型制約により、signature 変更が compile 時に検出される。vi.mock の silent 失敗がない。
- **依存グラフの可視化**: `composition.ts` の 1 ファイルから全依存関係が読める。新人エージェントが責務フローを理解しやすい。
- **テスト環境と本番の同一化**: production と test が同じ `AppContext` shape を共有するため、差分が「ports と clock の実装だけ」に局所化する。環境による動作差分が最小化される。
- **Fake ports の再利用性**: `FakeSessionsPort` を複数テストで再利用できる。seed data の組み合わせで複雑な状態をセットアップ可能。

### 失うもの / 制約
- **間接層の追加**: 小さな read one-off クエリでも `ctx.ports.sessions.findSessionById` と書く。ただし naming は自然であり、AI の読みやすさに優る。
- **変更時のコスト**: port interface 変更は production / real port / fake port / すべての caller を同時に変える必要がある。ただし TypeScript がそれを強制するので安全。変更量は vi.mock 時代より増えるが、型安全性を買える。

### 運用上の含意
- 新 handler / scheduler 関数は `AppContext` 受領を前提に設計し、module-level import で db / repos を呼ばない。
- 既存の `vi.mock("../../src/db/repositories/...")` パターンを新規テストに**使わない**。Fake ports + seed を使う。
- renderer / message builder（DB 依存がない pure 関数）など、port 境界外のコンポーネントには既存の vi.mock を継続可能。

## Alternatives considered

### 代替案 A: DI コンテナ（inversify / tsyringe / awilix）
却下。decorator metadata / string token / container 登録の overhead に対し、4 名固定個人開発の規模では benefit が無い。interface + factory + closure で十分。

**再評価トリガ**: 依存グラフが深くなり手動配線が破綻する規模（handler 数 20+ / service 層追加）。

### 代替案 B: Module-level import を維持し vi.mock を継続
却下。interface drift が silent になり続ける問題を解決しない。module 変更で既存 mock が無効化される状況を検出できない。

### 代替案 C: effect-ts の Context / Layer
既に ADR-0017 で却下。同等以上の記述量で、runtime 依存と学習曲線の benefit が無い。

### 代替案 D: Settle を `src/workflow/` に移動する structural refactor
見送り。1500 LOC 規模では新ディレクトリを追加する churn が readability 向上を上回らない。settle の役割（orchestration）は本 ADR の ADR-0001 / ADR-0015 との組み合わせで既に明示されている。

**再評価トリガ**: orchestration ファイルが 3 つ以上になる、discord 以外の entry point が追加される。

## Operational implications

### 新 port / 新 repository method の追加手順
1. `src/ports/index.ts` に interface を追加 → `AppPorts` に組み込み。
2. `src/ports/real.ts` で production 実装を追加。
3. `tests/testing/ports.ts` で fake 実装を追加し `FakeXxxPort implements XxxPort` で型チェック。
4. caller は `ctx.ports.*` 経由で使用。

### 既存 vi.mock の扱い
- `vi.mock("../../src/db/repositories/...")` を**新規テストに書かない**。
- 既存テストで残る vi.mock は renderer（`render*.ts`）など、port 境界外のものに限定。段階的に Fake ports へ移行。

### Test seed 設計
Fake ports が DB 相当の重要な property（unique 制約 / CAS semantics / 状態遷移ルール）を再現できるレベルまで実装し、test seed を通じて任意の前提状態をセットアップ可能にする。
