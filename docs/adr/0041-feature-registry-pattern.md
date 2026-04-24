---
adr: 0041
title: feature registry による dispatcher の安定モジュール化
status: accepted
date: 2026-04-25
supersedes: []
superseded-by: null
tags: [runtime, discord, docs]
---

# ADR-0041: feature registry による dispatcher の安定モジュール化

## TL;DR

`src/discord/shared/dispatcher.ts` の `customId.startsWith(...)` / `commandName === ...` ハードコード分岐を、各 feature が export する `FeatureModule` を集約した registry に置き換える。新 feature 追加時の編集点を「feature 内 `module.ts` 追加 + `modules.ts` への append」の 2 ファイルに収束させ、dispatcher を真の安定モジュール（高 Ca / 変更頻度ゼロ）に昇格させる。

## Context

`docs/reviews/2026-04-24/01-module-stability.md` および `11-modifiability.md` で、dispatcher が新 feature 追加のたびに以下 5 箇所の編集を強制する集中的編集点として識別された:

1. button handler import（1 行）
2. command handler import（1 行）
3. `handleButton` の `customId.startsWith("xxx:")` 分岐追加
4. `handleInteraction` の `commandName === "xxx"` 分岐追加
5. `src/commands/definitions.ts` の `SlashCommandBuilder` 配列への追加

dispatcher は `Ce`（fan-out）が 6+ feature に伸び続ける構造で、Martin metric では Instability `I → 1`、すなわち最不安定モジュール。ところが「feature 数の増減」というドメイン変化の影響を毎回受けるため、安定モジュールとしての性質（変更頻度の低さ）を満たさない。これは軸 01 stability と軸 11 modifiability の両方で減点要因となる。

加えて handler signature が 3 種に発散している:

| Handler | Signature |
|---|---|
| `handleAskButton` | `(interaction, deps)` |
| `handlePostponeButton` | `(interaction, deps, { acknowledged })` |
| `handleCancelWeekButton` | `(interaction, deps, { acknowledged })` |
| `handleAskCommand` | `(interaction, deps)` |
| `handleCancelWeekCommand` | `(interaction)` |
| `handleStatusCommand` | `(interaction, ctx: AppContext)` |

dispatcher は各 handler の差異を if-else 内で吸収しており、軸 14 uniformity も損ねている。

ADR-0040 で orchestration 層を導入し副作用 feature→feature import を解消したことで、feature の表面（button.ts / command.ts）は handler 関数のみという純粋な entry point となった。registry pattern を導入する前提条件は揃っている。

## Decision

### 1. `FeatureModule` interface を導入する

`src/discord/registry/types.ts` に以下を定義:

```ts
export type ButtonHandler = (
  interaction: ButtonInteraction,
  deps: InteractionHandlerDeps,
  ack: { readonly acknowledged: true }
) => Promise<void>;

export type CommandHandler = (
  interaction: ChatInputCommandInteraction,
  deps: InteractionHandlerDeps
) => Promise<void>;

export interface ButtonRoute {
  readonly customIdPrefix: string;        // 必ず ":" 終端
  readonly handle: ButtonHandler;
}

export interface CommandRoute {
  readonly name: string;
  readonly builder: SlashCommandBuilder;
  readonly handle: CommandHandler;
}

export interface FeatureModule {
  readonly id: string;                     // ログ・debug 用
  readonly buttons?: readonly ButtonRoute[];
  readonly commands?: readonly CommandRoute[];
}
```

各 feature は `src/features/<name>/module.ts` で `FeatureModule` を export する（button のみ / command のみ / 両方持ちは feature 自由）。

### 2. `buildFeatureRegistry(modules)` を導入する

`src/discord/registry/index.ts`:

```ts
export interface FeatureRegistry {
  readonly resolveButton: (customId: string) => ButtonRoute | undefined;
  readonly resolveCommand: (name: string) => CommandRoute | undefined;
  readonly slashBuilders: readonly SlashCommandBuilder[];
}

export const buildFeatureRegistry = (modules: readonly FeatureModule[]): FeatureRegistry;
```

build 時に以下を fail-fast 検証する:

- `customIdPrefix` が `:` で終わらない → throw
- `customIdPrefix` の重複 → throw
- 別 prefix が互いを prefix 包含する関係 → throw（解決順依存を防ぐ）
- `commandName` の重複 → throw

build 失敗は起動を停止させる。silent drift を許容するより明示崩壊を選ぶ（ADR-0017 minimalism と整合）。

### 3. handler signature を統一する

- `handleStatusCommand`: 第 2 引数を `deps: InteractionHandlerDeps` に変更し内部で `deps.context` を取り出す。
- `handleCancelWeekCommand`: `_deps: InteractionHandlerDeps` を第 2 引数に追加（型統一のため、内部では未使用）。
- button 系全 3 ファイル: 第 3 引数 `{ acknowledged: true }` を受け取る形に統一。`ask-session` は引数を `_ack` で受け流す。

これにより registry が一律シグネチャで `route.handle(interaction, deps, ackContext?)` を呼べる。

### 4. dispatcher.ts を registry 駆動に書き換える

dispatcher は registry の resolve 結果に従い handler を呼ぶだけになる。`customId.startsWith(...)` / `commandName === ...` のハードコード分岐は完全に消滅する。stale button / unknown command の reject path は dispatcher に残す（feature 横断の error path であり registry の責務外）。

`registerInteractionHandlers` は registry を optional DI として受け取り、デフォルトは `buildFeatureRegistry(featureModules)` を使う（テスト容易性、軸 08）。

### 5. `src/commands/definitions.ts` を registry 駆動に書き換える

`SlashCommandBuilder` の inline 生成を全廃し、`registry.slashBuilders` から `slashCommands` を導出する。`ask` / `cancel_week` の builder は対応 feature の `module.ts` に移設する（status は既に `statusCommandBuilder` が feature 内にある）。

## Consequences

### Follow-up obligations

- registry build の単体テストを `tests/discord/registry/build.test.ts` に追加し、上記 4 種の検証ロジックを保証する。
- 既存の dispatcher / definitions の挙動は完全不変。309+ test の挙動保証で gate する。
- `docs/reviews/2026-04-24/` の 01 / 11 / 09 / 06 / 14 軸を再評価する（dispatcher の Ce は実装上不変だが、変更頻度の意味での安定性は質的に変化）。

### Operational invariants & footguns

- **fail-fast**: registry build 失敗は起動停止。CI（`pnpm build`）で検出されるが、ローカル変更時は `pnpm test` まで通ること。
- **prefix 包含禁止**: `"ask:"` / `"ask:foo:"` の同時登録は禁止。新 feature 追加時に既存 prefix と衝突しないか build が検証する。
- **handler signature**: 第 3 引数 `ack` は dispatcher が `deferUpdate` 完了後に渡す signal。feature 側が defer を再実行しないこと。
- **新 feature 追加時の唯一の編集点**: `src/features/<name>/module.ts` 新規作成 + `src/discord/registry/modules.ts` の配列に append。これを破る変更（dispatcher.ts や definitions.ts への分岐追加）は code review で reject すること。
- **interaction-reject の扱い**: dispatcher 内 reject 文言（stale button / unknown command）は registry 化しない。feature 横断の error path であり、shared resource（`rejectMessages.ts`）として保持する。

### Trade-offs

- registry / module 用に新規ファイル 4–5 本（registry 3 + module × 4）。ADR-0017 minimalism に対する tax。
- aggregator 的な `module.ts` が 4 本生まれる。形式上は薄いが、feature 境界の宣言として価値がある。
- registry build は起動 1 回のみ実行されるため runtime overhead は無視できる。

## Alternatives considered

- **状態維持（dispatcher の if-else を継続）**: 却下理由 = 軸 11 の編集点 5 箇所が解消されない。feature 数増加に対し dispatcher の Ca が伸び続ける。
- **discord.js commands/v2 collector を自前実装する**: 却下理由 = ADR-0017 minimalism に反する。registry pattern で十分。
- **TypeScript decorator / metadata reflection で feature を自動登録する**: 却下理由 = TS decorator は仕様が不安定（stage 3 → stage 2 へ巻き戻し履歴あり）、暗黙性が増し AI 可読性も低下（ADR-0010）。
- **feature event bus**: 却下理由 = ADR-0040 で既に却下。feature 数 4 で event bus は過剰。
- **registry を feature 自身が `register(registry)` する形（push 方式）**: 却下理由 = `discord/shared/registry.ts → features/*` の依存方向が逆転する（ADR-0028 と衝突）。pull 方式（registry が module を import）で依存方向を保つ。
- **`module.ts` を作らず button.ts / command.ts に `FeatureModule` を直接 export させる**: 却下理由 = 1 feature が複数 entry を持つ場合（cancel-week は button + command 両方）の集約点が必要。`module.ts` は entry の barrel として明示する役割。

## Re-evaluation triggers

- feature 数が 6 を超えた場合 → registry の build 検証ロジックの拡張（同一 prefix 内の sub-route 階層化など）を検討する。
- handler signature がさらに発散した場合（例: modal / select menu の追加）→ registry に新 route 種別を追加するか、別 registry に分離するか判断する。
- registry build が起動時 100ms を超えるようになった場合 → 検証ロジックの遅延化を検討する（現在は無視できる）。
- `module.ts` aggregator が薄すぎて新規参加者の認知負荷を上げる兆候が出た場合 → button.ts / command.ts への inline 化を再検討する。
- 1 feature が 3 種以上の interaction kind を扱うようになった場合 → registry 構造の再設計を検討する。

## Links

- ADR-0010（コメント / ネーミング規約 / AI 可読性）
- ADR-0017（却下した代替案 / minimalism）
- ADR-0026（境界の再整理）
- ADR-0027（UI colocation と shared boundary）
- ADR-0028（viewModels as feature assets / pure-only 原則 / 依存方向）
- ADR-0037（feature locality 優先）
- ADR-0040（orchestration layer / 本 ADR の前提）
- `docs/reviews/2026-04-24/01-module-stability.md`
- `docs/reviews/2026-04-24/11-modifiability.md`
- `docs/reviews/2026-04-24/14-uniformity.md`
- `src/discord/shared/dispatcher.ts`
- `src/commands/definitions.ts`
