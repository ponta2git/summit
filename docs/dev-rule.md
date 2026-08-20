# Development Rule

Summit のtoolchain、package command、source layout、TypeScript、命名、comment、local DB、Git/PR運用を定める。業務仕様は`requirements/base.md`、設計は各`docs/*-rule.md`を参照する。

## 1. Toolchain

- Node.jsとpnpmは`package.json`およびmiseで固定したversionを使う。
- package managerをnpm/yarnへ切り替えず、lockfileを手編集しない。
- Node.js 24のnative TypeScript type strippingで開発entrypointとdev scriptを実行する。
- local relative importは`.ts`拡張子を正規形とし、TypeScript buildが出力時に`.js`へrewriteする。
- sourceはESM固定。`require()`、CommonJS module、暗黙のextension解決を追加しない。
- native TypeScript runtimeは型検査をしない。`pnpm typecheck`と`pnpm build`を別途通す。
- Node runtimeでeraseできないTypeScript syntaxを導入しない。`erasableSyntaxOnly`を弱めない。
- optional peerを含む利用toolはmanifestへ明示し、pnpmのpeer自動installを有効へ戻さない。
- `tsx`、`ts-node`、`jiti`等の別TypeScript runtimeを安易に追加しない。

Node native TypeScriptが現在のESM/importを扱えなくなった場合、またはnon-erasable syntaxが実要件になった場合にruntimeを再評価する。単なる好みで複数のdev実行基盤を併存させない。

## 2. 主要command

| command | 用途 |
|---|---|
| `pnpm dev` | native TypeScript + Node watchで起動 |
| `pnpm typecheck` | TypeScript型検査 |
| `pnpm lint` | oxlint |
| `pnpm lint:knip` | 未使用ファイル・export・依存関係の検査 |
| `pnpm test` | unit/application tests |
| `pnpm test:integration` | local guarded DB integration |
| `pnpm build` | production JavaScript生成 |
| `pnpm verify:forbidden` | 危険patternと依存方向の検査 |
| `pnpm verify:file-size` | source file size advisory |
| `pnpm verify:docs` | 文書topologyとagent adapter検査 |
| `pnpm run ci` | 日常の全static/unit品質ゲート |
| `pnpm commands:sync` | guild-scoped slash command同期 |
| `pnpm db:seed` | local member seed |
| `pnpm db:reset` | local transient state reset |

重要: `pnpm ci`はpackage scriptではなくpnpmのinstall系commandとして解釈される。品質ゲートには必ず`pnpm run ci`を使う。

## 3. TypeScript

- strict、exact optional property、unchecked indexed access等のcompiler設定を弱めない。
- `any`を使わない。外部入力は`unknown`で受け、zodまたは型guardでnarrowする。
- `as`は型情報を構造的に回復できない境界だけに限定する。二重castや`as never`で不一致を隠さない。
- unionはdiscriminantを持たせ、exhaustive branchは`assertNever`で閉じる。
- public function、repository、service、handlerのreturn typeを明示する。
- config/DTOはreadonly、constant mapは`as const satisfies`を優先する。
- `@ts-ignore`を常用しない。必要な場合は理由、範囲、撤去条件を近傍に残す。
- independent I/Oだけを`Promise.all`で並列化し、順序契約のあるI/Oを見かけ上並列にしない。
- naked promiseを残さない。fire-and-forgetは`void`と最外周catchを明示する。

## 4. Source layout

- `src/`はproduction runtimeだけを置く。
- `scripts/dev/`はseed、reset、scenario等のlocal toolを置く。
- `scripts/verify/`は決定論的CI guardを置く。
- featureのhandler/render/messages/view modelは`src/features/<feature>/`へcolocateする。
- cross-feature副作用は`src/orchestration/`、pure aggregate decisionは`src/domain/`へ置く。
- DB consumer boundaryは`src/db/`、Discord共通infraは`src/discord/`、時刻は`src/time/`へ置く。
- barrelはpublic surfaceを意図的に制限する場所だけに使い、named re-exportを優先する。
- 1ファイル1責務。300行超は自動失敗ではないが、責務分割をreviewする。

## 5. Naming

関数prefixで副作用の意味を固定する。

| prefix | 意味 |
|---|---|
| `build*` | I/Oのない値構築 |
| `render*` | I/Oのない表示変換 |
| `send*` | Discord/HTTP/DB write等の副作用 |
| `find*` | DB readで0〜N件 |
| `get*` | 値が必ず返るpure accessor |
| `try*` | 条件不足でno-op/undefinedになり得る処理 |
| `handle*` | Interaction等のentry handler |
| `run*Tick` | schedulerの一回実行単位 |
| `create*` | entity作成 |
| `upsert*` | 更新または作成 |
| `settle*` | deadline/投票後の収束 |
| `transition*` | 一段のstate transition |

- `build*`にDB/API I/Oを入れない。
- 意味の曖昧な`refresh*`を使わず、read/update/sendへ分ける。
- 文字列日付は`*Iso`、`Date` objectにはsuffixを付けない。
- typeは`PascalCase`、fileは`camelCase.ts`を基本とする。既存の責務suffix fileはmodule規約を維持する。
- 業務語彙は`requirements/base.md`に合わせ、類義語へ勝手にrenameしない。
- DB row typeはschema inferenceを起点とし、意味のない独自aliasを増やさない。

## 6. Comment

優先順位:

1. nameと型で伝える。
2. codeから分かるWHAT/HOWは書かない。
3. invariant、race、非自明な理由、一時互換だけを書く。
4. 実行リテラル、schema、業務仕様を再記述しない。
5. 古い外部文書へのlinkだけでcommentの意味を成立させない。

TSDocはmodule境界を越えるexportか、非自明なcontractを持つfunctionに限定する。本文は簡潔な英語、`@remarks`の業務説明は日本語でもよい。自明な`@param`列挙は書かない。

通常commentは日本語で、検索可能なprefixを使う。

| prefix | 用途 |
|---|---|
| `why:` | 方針選択理由 |
| `invariant:` | 維持すべき条件 |
| `race:` | 競合時の挙動 |
| `idempotent:` | 冪等化方法 |
| `jst:` / `iso-week:` | 時刻・週境界 |
| `state:` | state transition |
| `source-of-truth:` | 正本の所在 |
| `ack:` | Discord応答期限 |
| `unique:` / `tx:` | DB制約・transaction |
| `single-instance:` | topology依存 |
| `deploy-window:` | 運用禁止窓 |
| `redact:` / `secret:` | 秘匿値保護 |
| `compat:` | 一時互換。撤去条件を設計文書へ持つ |
| `todo(ai):` | 仕様未確定。PR要確認事項と対応 |
| `regression:` | 非自明な過去bug回帰 |

module preambleは、file名だけでは複数module間のorchestration責務が読めない場合に2〜4行だけ置く。装飾区切り、目次、実装と乖離した説明は削除する。

## 7. Environment、secret、logging

- local secretは`.env.local`、commit可能なのはplaceholderだけの`.env.example`。
- user向け非secret設定は`*.config.yml`の既定の追跡方針に従う。
- runtime codeは`src/env.ts`と`src/userConfig.ts`のparse済み値を使う。
- token、接続文字列、monitor URL、Authorizationをcode、fixture、log、PR、commitへ載せない。
- `console.*`を残さずpino loggerを使う。
- redact pathを狭める変更はsecurity-sensitiveとしてreviewする。
- Fly secretのunset/上書きはrunbookなしに実行しない。

## 8. Local DB

- local DBはmomo-dbのcompose/migrationを使用する。
- 週次flowをやり直すときは`pnpm db:reset`を使う。
- memberを含めて消す必要がある場合だけ`pnpm db:reset --all`を使い、その後seedする。
- `docker exec`や`psql`で手動TRUNCATEしない。
- reset scriptのhost guardを迂回しない。
- schema変更はmomo-dbで行い、Summit側へmigration toolを再導入しない。

## 9. Git とPR

- commit messageは英語のConventional Commits。
- PR本文は日本語で、変更点、仮定、要確認事項、影響範囲、テスト、運用影響、リスク、変更した設計文書を書く。
- 業務仕様変更と文書topology移行など、異なるreview判断を必要とする変更はcommitまたはPRを分ける。
- 設計変更は対応するliving documentを同じPRで更新する。番号付きの判断履歴文書を追加しない。
- 理由、非採用案、再評価条件はPRと現在の設計文書に残し、完了済み実装計画をdocsへ蓄積しない。
- 既存のuser変更があるdirty worktreeでは、無関係な差分を編集・revertしない。

## 10. 完了条件

- 仕様、設計文書、code、testが同じcontractを示す。
- `git diff --check`が通る。
- `pnpm run ci`が通る。
- DB契約変更ではintegration test、運用変更では該当runbook確認を完了する。
- secret、production destructive operation、deploy禁止窓、single-instance逸脱がない。
- new warningやbaseline failureを隠していない。
