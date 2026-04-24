---
applyTo: "tests/**/*.ts"
---

# Testing Rules

このリポジトリのテストは、仕様・契約・副作用境界を検証し、production code の内部リファクタに過度に結合しないことを優先する。

## Mock / fake boundary

- repository module を新規に `vi.mock(...)` しない。DB 依存は `createTestAppContext` の fake ports、または `tests/integration/**` の real DB contract で検証する。
- `vi.mock(...)` は Discord API helper、cron scheduler、HTTP/fetch、logger、orchestration boundary など外部境界に限定する。
- Discord client/channel/message の fake は `tests/helpers/discord.ts` に寄せ、各テストに `as unknown as Client` を散らさない。
- fake ports は production contract の写像として扱う。CAS / unique / outbox dedupe などの semantics を便利都合で緩めない。

## Assertion strictness

- pure function / view-model / message builder は `toStrictEqual` や具体値比較を優先し、仕様として安定した形を厳密に見る。
- handler / scheduler / orchestration は、最終的な永続 state、user-facing response、outbox/Discord boundary の意味を検証する。
- `toHaveBeenNthCalledWith` や raw call order assertion は、順序自体が仕様・race invariant の場合だけ使う。
- `expect.any` / `expect.objectContaining` / `expect.arrayContaining` は、Discord SDK payload の非本質部分や時刻などを意図的に緩める場合に限定する。

## Fixtures and scenarios

- bare `Partial<SessionRow>` を各テストに広げすぎず、業務状態が分かる builder / scenario helper を優先する。
- 代表 scenario は「4 members」「全員時刻回答」「欠席」「順延 OK/NG」「金曜/土曜 cancelled」「decided/reminder」など業務語彙で命名する。
- 実行されるリテラル値や業務仕様は再記述しない。必要なら `requirements/base.md`、`src/config.ts`、`src/time/`、`src/db/schema.ts` への pointer に留める。

## Race and time

- race test は `tests/helpers/deferred.ts` など明示的な同期点を使い、timeout や arbitrary sleep に依存しない。
- 時刻固定は `createTestAppContext({ now })` または `tests/testing/time.ts` を使い、テスト本体で現在時刻を暗黙参照しない。
- JST / ISO week / deadline / `24:00` 境界の regression は、テスト名で保証内容を明確にし、非自明な回帰には `// regression:` を付ける。

## Integration tests

- integration は `INTEGRATION_DB=1` gate と localhost guard を維持し、`tests/integration/_support.ts` の setup helper を使う。
- real DB contract は repository / migration / constraint / transaction semantics の確認に絞る。unit で十分な Discord flow を integration に重複させない。
