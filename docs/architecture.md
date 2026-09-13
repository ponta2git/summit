# Architecture

Summit の現在の runtime 構造、依存方向、scheduler、依存注入、エラー境界、設定境界を定める。ユーザーに見える挙動は `requirements/base.md`、DB の詳細は `docs/db-rule.md`、Discord Interaction は `docs/discord-rule.md` を正本とする。

## 1. Runtime topology

- Node.js / TypeScript / ESM の単一 Bot process を Fly.io の単一 machine で常時起動する。
- horizontal scale、scale-to-zero、外部 cron からの短時間起動は現在の設計対象外とする。
- cron と Discord client は process 起動中に一度だけ登録する。ローカルを含め、同じ設定で Bot を二重起動しない。
- 永続状態の正本は PostgreSQL。Discord 表示と process 内の timer、lock、cache は再構築可能な派生状態とする。
- 起動・再接続時は DB から非終端 Session と未配送 intent を再読込し、処理を冪等に収束させる。
- 同じprocessがA/B通知用のprivate HTTP受信と配送を所有する。公開HTTP serviceや追加Machineを作らず、private bindを設定時と起動時に検査する。

単一インスタンスを採用する理由は、固定4名の個人 Bot に分散 leader election や複数 scheduler の運用コストを持ち込まないためである。ただし DB の unique、CAS、claim token は interaction 同時押下や期限切れ worker の競合を防ぐため、単一 process でも必須とする。

### 再評価条件

- 複数 application instance または複数 outbox worker を常時動かす必要が生じる。
- 可用性要件が単一 machine の再起動回復では満たせなくなる。
- Fly または Discord が安全な event-driven wake / leader election を提供する。

該当時は、scheduler ownership、cron 排他、outbox claim、startup recovery を一体で再設計する。scale 数だけを先に変更しない。

## 2. Source layout と依存方向

```text
src/index.ts
├── src/appContext.ts ──> src/db/ports.real.ts ──> repositories
├── src/discord/registry/ ──> src/features/* entry handlers
└── src/scheduler/ ──> src/orchestration/ ──> src/features/*

src/features/* ──> pure feature assets / AppContext ports
src/orchestration/* ──>複数 feature の副作用順序
src/domain/* ──> pure aggregate decision
src/time/* ──> project-wide clock / JST calculation
src/db/* ──> persistence boundary
```

依存規則:

- `src/features/<feature>/` は handler、render、message、view model、feature 固有の pure decision を所有する。
- feature 固有の資材は、ファイルが小さいという理由だけで `src/discord/shared/` へ移さない。
- feature 間では pure 型・builder・定数だけを参照できる。`send.ts`、`settle.ts`、`messageEditor.ts` の副作用 import は禁止する。
- 複数 feature を跨ぐ副作用は `src/orchestration/` が順序駆動する。feature から orchestration への逆向き依存は作らない。
- `src/discord/shared/` は dispatcher、guard、custom ID codec、共通 DTO、Discord SDK の薄い helper に限定する。
- `src/domain/` は I/O と global clock を持たない aggregate decision の配置先とする。現在は ASKING と POSTPONE_VOTING の判定を所有する。
- `src/time/`、`src/scheduler/`、`src/db/`、`src/members/` は横断 infrastructure であり、feature 配下へ分散しない。
- `src/` は production runtime、`scripts/dev/` は開発用の seed/reset/scenario を所有する。
- `src/notifications/`はA/BのHTTP認証・受付制限・運用CLIとresource合成、`src/features/result-notifications/`は固定本文、`src/scheduler/resultNotifications*`は配送を所有する。
- generic な `types.ts` や `util/` に責務を隠さず、型は所有 module、共有 assertion は用途名の module に置く。

`src/features/` を locality 単位にする理由は、変更時に user-facing copy、render、handler、テスト対象を同じ機能名で探索できるようにするためである。shared 抽出で import 数を減らすことより、ownership の明確さを優先する。

### Registry

各 Interaction feature は `module.ts` から route と slash builder を公開し、`src/discord/registry/modules.ts` に追加する。registry build は次を fail-fast で検証する。

- custom ID prefix が所定の終端形式を持つ。
- prefix または command name が重複していない。
- prefix 同士が包含関係を持たず、探索順に依存しない。

dispatcher と command definitions に feature 名の分岐を追加しない。modal や select menu など新しい Interaction 種別を導入するときは、registry の route 種別を追加するか分離するかを先に設計する。

## 3. Composition と ports

唯一の production 合成点は `src/appContext.ts` とする。

```ts
interface AppContext {
  readonly ports: AppPorts;
  readonly clock: Clock;
}
```

- handler、scheduler、orchestration は `AppContext` を受け取り、DB へは `ctx.ports.*`、時刻へは `ctx.clock` でアクセスする。
- repository、DB client、`systemClock` をこれらの call-site から直接 import しない。
- production は `makeRealPorts`、test は `createTestAppContext` が同じ `AppPorts` 契約を実装する。
- port interface を変更したら real と fake を同じ変更で更新する。
- `/status` は `StatusPort.loadCurrentWeekSnapshot` が current-week Session と画面用の Response / HeldEvent を
  batch 取得する。ResponsesPort / HeldEventsPort に汎用 batch API を増やさず、read model の結合知識を status
  repository 内へ隠す。
- Discord client は意図的に port 化しない。discord.js の rich type を薄い独自抽象へ写す利益が現在の規模では小さいためである。
- DI container は使わない。resource graph が factory 合成で追跡できなくなった場合にだけ再評価する。

## 4. Domain と state transition

- 業務状態と許可遷移の語彙は `requirements/base.md`、実装型は `../momo-db/src/schema.ts` と `src/db/rows.ts` を参照する。
- pure decision は discriminated union を返し、業務上の中止・pending・決定を例外で表現しない。
- write path は Session aggregate を lock し、同じ snapshot で入力、期限、Response、遷移を評価する。
- 任意の from/to を受け取る汎用遷移 API は公開しない。edge-specific command と期待状態付き更新で許可遷移を閉じる。
- Sessionの`CANCELLED`は外部通知を同じaggregate commandで確定する短命中間状態。通知自体の`CANCELLED`は終端であり、A/Bを起動時に復帰させない。

XState と event sourcing は採用しない。現在の状態数と監査要求では、DB state、pure decision、typed command、CAS の方が小さく直接的である。並行状態、履歴状態、過去時点再生、監査イベントが実要件になったとき再評価する。

## 5. Error boundary

エラー分類の実装正本は `src/errors/` とする。

- `AppError.code` で invariant、validation、not found、Discord API、database、shutdown を判別する。
- `cause` は診断用に保持するが、必ず logger redact を通す。
- Interaction pipeline、cross-feature orchestration、scheduler application operation の複数 I/O 合成には `Result` / `ResultAsync` を使う。
- repository、ports、pure domain、timer mechanics を blanket に `ResultAsync` 化しない。
- CAS race、重複、claim lost、no-op は例外ではなく typed return / state return で表現する。
- cron / timer callback は `Promise<void>` adapter で Result を unwrap し、失敗を tick 外へ持ち越さない。
- batch scheduler は item 単位の recoverable failure を report に集め、query 全体の失敗だけを上位へ返す。
- config/env parse、`assertNever`、起動不能な impossible state は fail-fast を許可する。
- fire-and-forget は最外周で明示的に catch し、unhandled rejection を作らない。
- A/B配送の結果はDB状態へ確定するため、dispatcher境界は`Promise<void>`を受け取る。配送内部が送達不明・恒久失敗・claim失効を分類し、最終保存の失敗も回収可能な状態と安全なlogへ収束させる。

effect system を採用しない理由は、現在の resource graph と failure policy が `AppContext`、typed return、neverthrow の境界利用で表現できるためである。DI、resource lifecycle、fiber cancellation が複数 subsystem で必要になったとき再評価する。

## 6. Scheduler architecture

### Calendar cron と DB-driven controller

process 起動時に登録する固定 cron は、calendar 起点の募集、retention、scheduler supervisor に限定する。cron 式と間隔の実値は `src/config.ts` が正本であり、本書へ写さない。

deadline、postpone deadline、reminder、outbox dispatch は DB の次回時刻から one-shot timer を再構築する。

1. `SessionsPort.getSchedulerSessionHints` と `OutboxPort.getNextDispatchAt` を読む。
2. future work は one-shot timer を張る。
3. due work は既存 operation を `runResultTickSafely` 経由で実行する。
4. work 後に DB を再読込し、同じ recompute 中に新しい種類の due work と新規 outbox intentを認識する。
5. 同じ due kind は一回の recompute で一度だけ試す。reminder は配送完了まで due のままになり得るため、無制限再計算を防ぐ。
6. outbox は作業がある間だけ burst worker を動かし、idle なら停止する。

interaction、aggregate command、startup/reconnect が新しい work を作った場合は `wakeScheduler(reason)` を呼ぶ。supervisor は missed wake、claim expiry、timer drift の fallback であり、通常経路が supervisor の次回実行を待つ設計にしない。

### Startup と reconnect

- startup 中と reconnect replay 中は application readiness を false にし、Interaction を ephemeral で拒否する。
- startup は dead-letter chain recovery、expired claim、stranded transition、missing intent/message、期限超過 Session を DB から収束させる。
- reconnect は in-flight lock と debounce を併用し、初回 ready と並行 replay を区別する。lockは処理開始前に登録し、同期例外・Result失敗の両方で解放する。debounceは成功完了時から測り、失敗後は次の再接続で再試行できる。
- Discord message の active probe は API 負荷が高いため startup に限定する。通常 tick は Unknown Message を検出したとき opportunistic に再生成する。
- poison payload の FAILED 復帰は startup だけで行い、定期 tick や reconnect で hot loop を作らない。

### A/Bの受信と配送

- `ResultNotificationsPort`を通して受付commandをcommitしてから2xxとwakeを返す。HTTP deadlineを過ぎても実行中commandの受付枠を返さず、commit後の切断でも配送状態を失敗へ変更しない。
- startup完了前は503。一度startupが完了すれば一時的なDiscord再接続中もDBへ受付でき、外部配送失敗はconsumerが処理する。
- dispatcherは上限付きの独立slot、完了ごとのwake、次回retry/claim期限のone-shotを持つ。処理中・idleへの移行中のwakeを保持する。DB障害は有限backoff後に停止し、新しいwakeまたは既存supervisorで再開する。
- DB障害の連続回数は、claimと必要な次回配送時刻の取得がすべて成功してから戻す。時刻取得だけの障害でも再試行上限を維持する。
- supervisorのA/B wakeをattendance処理より先に呼び、一方の障害で他方を抑止しない。retentionもfamilyごとに独立させる。idle中に短周期DB pollingを追加しない。
- Discord待機中はclaimを延長するがDB transactionを保持しない。開始・確定時のCASが失効ownerを排除する。部分数・renderer・宛先・リンクを初回計画から変更しない。
- shutdownはreceiverとdispatcherの新規仕事を止め、受付と送信を上限付きでdrainしてDB・Discordを閉じる。未完了claimは次の起動で回収する。値は`src/config.ts`と`src/notifications/config.ts`を参照する。

## 7. Configuration と logging

設定境界は3層に分ける。

| 層 | 所有する情報 | 実装 |
|---|---|---|
| User config | guild/channel、固定 member、利用者向けschedule/slot、dev mention抑止 | YAML本文を `src/userConfig.ts` が zod parse |
| Environment | secret、DB接続、config YAML本文、deploy metadata | `src/env.ts` が起動時に一度 parse |
| Internal config | outbox、scheduler、retention、metrics 等の信頼性 tuning | `src/config.ts` |

- application code は parse 済みの `env` / `appConfig` / exported constant だけを使う。
- `process.env`は既存の設定入口と明示したCLI入口に限定する。`src/notifications/cli.ts`は運用接続設定だけを注入し、Bot全体のenv読込やDiscordログインを行わない。
- user config は重複しない固定4名のidentityを検証し、起動時に表示名と一つのtransactionでDBへreconcileする。過去履歴を守るため、設定から消えたmember rowは自動削除せず、既存IDも再利用しない。新規IDの生成はreconcileが所有し、設定の配列順に依存させない。
- pino の構造化 JSON を stdout へ出す。`console.*` は使用しない。
- token、接続文字列、Authorization は logger redact から外さない。
- Interaction payload や SQL bind を丸ごと記録せず、必要な識別子と状態遷移の `from` / `to` / `reason` に限定する。
- 外部 healthcheck ping はアプリから送信しない。運用観測は構造化ログと `/status` を基本とする。
- A/B有効化は受信token・別の運用token・Web originの3項目を一組にする。部分設定や同じtokenの兼用を起動時に拒否する。状態・設定・再試行の専用CLIは[通知運用](operations/result-notifications.md)を参照する。

OpenTelemetry は、単一 service のログ調査に collector / backend 運用を追加する価値がないため採用しない。複数 service の trace、SLO、相関 ID 横断が必要になったとき再評価する。

## 8. 主要な非採用案

| 案 | 現在採用しない理由 | 再評価条件 |
|---|---|---|
| DI container | factory と `AppContext` で graph が追える | resource lifecycle と provider 数が factory で追跡困難になる |
| XState | typed state + pure decision + DB CAS で十分 | 並行/履歴状態や複雑な guard が増える |
| effect system | failure policy に対して runtime/学習コストが過大 | structured concurrency とresource管理が主要課題になる |
| Event sourcing | 過去時点再構成・監査要求がない | replay、監査、過去ルール再計算が要件になる |
| OpenTelemetry | 単一serviceの構造化ログで足りる | 複数service traceとSLO運用が必要になる |
| 外部message broker | PostgreSQL outboxで規模と運用を満たす | outbox量・latency・運用負荷がbroker導入コストを上回る |

## 9. 変更時の検証

変更で影響を受ける契約について、次の観点と `docs/test-rule.md` の品質 gate を適用する。

- dependency direction: `pnpm verify:forbidden`
- type/error/port contract: `pnpm typecheck` と unit tests
- scheduler: fake clock、明示同期点、due-kind一回制約、wake/supervisor fallback
- registry: duplicate/prefix conflict の fail-fast tests
- startup/reconnect: readiness、in-flight lock、scope別 recovery tests
- DB semantics を変える場合: `docs/db-rule.md` に従い real DB contract tests
