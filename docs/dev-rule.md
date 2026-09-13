# Development Rule

Summit のtoolchain、package command、source layout、TypeScript、命名、comment、local DB、Git/PR運用を定める。業務仕様は`requirements/base.md`、設計は各`docs/*-rule.md`を参照する。

## 1. Toolchain

- Node.jsとpnpmは`package.json`およびmiseで固定したversionを使う。
- package managerをnpm/yarnへ切り替えず、lockfileを手編集しない。
- Node.js 24のnative TypeScript type strippingで開発entrypointとdev scriptを実行する。
- local relative importは`.ts`拡張子を正規形とし、TypeScript buildが出力時に`.js`へrewriteする。
- sourceはESM固定。`require()`、CommonJS module、暗黙のextension解決を追加しない。
- native TypeScript runtimeは型検査をしない。runtime 実装の変更は `docs/test-rule.md` の code gate で型検査と build を含める。
- Node runtimeでeraseできないTypeScript syntaxを導入しない。`erasableSyntaxOnly`を弱めない。
- optional peerを含む利用toolはmanifestへ明示し、pnpmのpeer自動installを有効へ戻さない。
- `tsx`、`ts-node`、`jiti`等の別TypeScript runtimeを安易に追加しない。

Node native TypeScriptが現在のESM/importを扱えなくなった場合、またはnon-erasable syntaxが実要件になった場合にruntimeを再評価する。単なる好みで複数のdev実行基盤を併存させない。

### 外部 API・tool の資料確認

ライブラリ、framework、SDK、API、CLI、cloud service の構文・設定・移行・固有の不具合を扱う場合は、記憶だけで実装せず現在の資料を確認する。

1. `package.json`、lockfile、toolchain 設定で対象 version を特定する。最新版の説明をそのまま導入済み version に適用しない。
2. Context7 の `resolve-library-id` に正式名称と具体的な質問を渡し、公式性・version・内容が最も合う ID を選ぶ。ユーザーが正確な `/org/project` 形式の ID を指定した場合だけ解決を省略する。
3. `query-docs` に選んだ ID と判断したい質問を渡す。取得内容が対象 version・機能を説明しているか確かめる。
4. Context7 が利用不可、情報不足、または指定された公式ページの内容を確認できない場合は、公式ドキュメントを直接取得する。検索 snippet だけで結論を出さず、根拠の URL と適用 version を必要な説明に添える。

業務ロジックの調査、一般的な refactor、code review、独自 script の作成に、外部仕様の判断がなければ資料取得は不要。質問に secret、私有コード、個人情報を含めない。資料が取れなくても既存実装と test で確かめられる作業は進め、未確認の API 契約に依存する部分だけを保留する。

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
| `pnpm docs:sync-agent` | `AGENTS.md` から agent adapter を生成し文書検査 |
| `pnpm run ci` | 全static/unit品質ゲート。変更別の適用条件は `docs/test-rule.md` |
| `pnpm commands:sync` | guild-scoped slash command同期 |
| `pnpm notifications inspect/retry/settings ...` | 稼働中private receiverでOCR・分析通知を操作。権限・使い方は`docs/operations/result-notifications.md` |
| `pnpm db:seed` | local member seed |
| `pnpm db:reset` | local transient state reset |

重要: `pnpm ci`はpackage scriptではなくpnpmのinstall系commandとして解釈される。品質ゲートには必ず`pnpm run ci`を使う。

`package.json` を command の実体とする。`dev`、`start`、`commands:sync` は外部サービスへ接続し、`setup`、DB script、integration test は DB の変更を伴う。検証のためにアプリ起動や command 同期を追加しない。`.env.local` や git 管理外 YAML を読む script は、`AGENTS.md` の読取条件も満たす必要がある。

探索・検証は必要な path に限定する。`verify:docs` と `docs:sync-agent` は現在、作業ディレクトリ内の対象拡張子を走査するため、git 管理外 YAML も読取対象になる。読取が許可されていない設定がある場合は、git 管理対象と今回の追加ファイルだけの一時コピーで検証し、設定の値をコピーしない。コピー先でも固定 runtime を使い、生成 adapter を作業元へ戻して、検証したファイルが作業元と一致することを確認する。

一時コピーでは Node / pnpm の実効 version も確認する。外部依存のない文書 script に限り、実行時の `pnpm_config_verify_deps_before_run=false` で pnpm の自動 install を抑止できる。repository / global の設定は変更しない。

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
- 機密値の扱いは `AGENTS.md` に従う。monitor URL も同じ扱いとする。
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

- 開始時と commit 前に branch、worktree、staged diff を確認する。既存のユーザー差分を編集・revert・stage せず、今回の対象だけを明示して stage する。同じファイルに既存差分がある場合は hunk を分けて確認する。
- commit を依頼されたら必要な gate と staged diff の確認後に実行し、hash と完了状態を報告する。commit の依頼を push・merge・deploy の許可へ拡張しない。履歴の書換や無関係な変更の破棄は、明示された依頼なしに行わない。
- commit messageは英語のConventional Commits。
- PR 本文は日本語で、解決する問題と変更後の挙動、理由、検証結果を先に書く。重要な仮定・要確認事項・影響範囲・運用影響・リスク・更新した正本は、該当するものだけを具体的に添える。小さな変更に空の見出しや定型チェックを増やさない。
- `.github/PULL_REQUEST_TEMPLATE.md` を使い、実行した command と pass / fail / 未実行を区別する。選んだ gate の理由や、必要な検証を実行できなかった理由を示す。予定の検証を完了済みにしない。
- 業務仕様変更と文書topology移行など、異なるreview判断を必要とする変更はcommitまたはPRを分ける。
- 設計変更は対応するliving documentを同じPRで更新する。番号付きの判断履歴文書を追加しない。
- 理由、非採用案、再評価条件はPRと現在の設計文書に残し、完了済み実装計画をdocsへ蓄積しない。

Linear チケットの実装と必要な確認が完了し、PR の merge をもって Done にする場合は、PR 本文に `Fixes <issue ID>` を記載する。`Refs <issue ID>` は merge 後も追加作業または受け入れ確認が残る場合だけ使用し、その残作業を示す。この記法はチケット更新・外部へのメッセージ送信・PR merge 自体の実行権限を与えない。
