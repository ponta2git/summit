# Development Rule

toolchain、command、外部資料、source の書き方、local DB、Git / PR の契約を定める。依存方向は [Architecture](./architecture.md)、検証の選択と完了条件は [テスト規約 §8](./test-rule.md#8-quality-gate) を使う。

## 1. Toolchain と資料確認

Node.js / pnpm は `package.json` と mise の固定 version を使う。package manager を切り替えず、lockfile を手編集しない。optional peer を含め必要な tool を manifest に明示し、peer の自動 install を有効へ戻さない。

開発 entrypoint / script は Node.js 24 の native TypeScript、production は build 後の JavaScript を実行する。ESM と relative import の `.ts` を正規形とし、build が `.js` へ rewrite する。CommonJS・暗黙の extension 解決・erase できない syntax を追加しない。native 実行は型検査ではないため、code gate で typecheck / build も通す。

別の TypeScript runtime は、現在の ESM / import を扱えなくなった場合や non-erasable syntax が実要件になった場合に再評価する。

### 外部仕様を判断するとき

ライブラリ、framework、SDK、API、CLI、cloud service の構文・設定・移行・固有の不具合を扱うときに資料を取得する。同じ作業で確認済みの根拠は再利用する。

1. manifest / lockfile / toolchain から対象 version と具体的な疑問を定める。
2. Context7 の `resolve-library-id` に正式名称と質問を渡し、公式性・version・内容が合う ID を選ぶ。正確な `/org/project` がユーザーから指定された場合だけ解決を省略する。
3. `query-docs` でその質問を取得し、対象 version / 機能への適用を確認する。
4. 利用不可・情報不足・指定公式ページを確認できない場合は公式本文を直接取得する。検索 snippet だけで判断せず、必要な説明に URL と適用 version を添える。

外部仕様の判断を伴わない業務ロジック調査・一般的 refactor / review・独自 script 作成では資料取得を追加しない。secret・私有コード・個人情報を query に含めない。取得失敗は未確認であって不在の証拠ではなく、依存する判断だけを保留する。

OpenAI 製品・モデル固有の指示設計は利用可能な OpenAI Docs skill を使い、指定モデルの公式本文を確認する。ユーザーが指定した取得順を優先する。API 移行を伴わない文書改訂に API key 読取やモデル設定変更を追加しない。

## 2. 主要command

実体は [package.json](../package.json)。実行対象と副作用を選んで使う。

| Command | 用途・境界 |
|---|---|
| `pnpm typecheck` / `pnpm build` | 型検査 / production JavaScript 生成 |
| `pnpm lint` / `pnpm lint:knip` | oxlint / 未使用 file・export・依存検査 |
| `pnpm test` | unit / application tests |
| `pnpm test:integration` | 明示した `TEST_DATABASE_URL` から作る使い捨て DB の検証 |
| `pnpm verify:forbidden` / `pnpm verify:file-size` | 禁止 pattern・依存方向 / file size advisory |
| `pnpm verify:runtime-image <local-image>` | build 済み image を network なし・read-only で検査。非 root、依存解決、開発依存の除外を確認し、Bot は起動しない |
| `pnpm verify:notification-capacity <local-image>` | 明示した local `TEST_DATABASE_URL` の使い捨て DB と本番 image を使用。新規標準上限の同時受付・配送と旧巨大通知を、256 MiB・swap なしで検証。標準ケースの cgroup peak は192 MiB以下を必須とし、Discord には接続しない |
| `pnpm profile:notifications <local-image> --output <new-directory>` | 専用 DB・256 MiB・1 CPU の本番 image で通知速度、GC、heap、event loop を計測。`--profile` は CPU / allocation profile を別実行に採取する。[性能レポート](./performance.md)の再現条件と評価限界を参照 |
| `pnpm verify:docs [--include <path>]` | 追跡文書と明示した新規 file、link / adapter の検査 |
| `pnpm docs:sync-agent [--include <path>]` | AGENTS から adapter を生成し、同じ範囲を検査 |
| `pnpm run ci` | static / unit / build の品質 gate |
| `pnpm dev` / `pnpm start` | watch 開発 / production 起動。外部サービスへ接続 |
| `pnpm commands:sync [--check]` | 開発 guild の同期。`--check` は外部 read のみ |
| `pnpm commands:sync:production [--check]` | 運用 PC から本番 guild を手動同期 |
| `pnpm notifications:record:test` | `mom24_` 専用 loopback DB で実受付・配送し、Discord 境界だけ所有 run directory に記録 |
| `pnpm notifications inspect/retry/settings ...` | 稼働中 private receiver の操作。[A/B runbook](./operations/result-notifications.md) に従う |
| `pnpm db:seed` / `pnpm db:reset` | guard 付き local member seed / transient state reset |

品質 gate は **`pnpm run ci`**。`pnpm ci` は pnpm の install 系 command として解釈されるため使わない。`setup`、DB script、integration は DB 変更を伴う。品質検証のためだけにアプリ起動・DB reset・外部同期を追加しない。local secret / git 管理外設定を読む command には AGENTS の読取条件も適用する。

本番 image は sibling を含む親 directory を context として `docker build --file summit/Dockerfile --tag summit-runtime-check .` で作る。[Dockerfile 固有の ignore](../Dockerfile.dockerignore) は必要な manifest / lock / source だけを許可し、local secret・別 project・node_modules を context に入れない。本番依存 stage と build stage を分け、runtime は root 所有の code を非 root で読む。build / ローカル image 検証を push / deploy の許可とは扱わない。

容量検証は `TEST_DATABASE_URL` を明示し、Docker host へ公開した local PostgreSQL port を使う。負荷 client と fixture は host 側、実処理は本番 image 内で実行する。専用 DB と container は固有名で作成・回収し、入力には tracked example 設定を使う。失敗時は OOM・受付拒否・期限・準備失敗を固定診断で区別し、接続文字列を表示しない。

容量検証の既定値は標準・旧通知の両ケースであり、`--scenario standard|legacy|all`、`--memory-mib`、`--target-mib` で調査条件を明示できる。標準の合格目標超過も失敗にする。旧通知は別 container で単独配送し、同じ目標との比較と OOM の有無を別に報告する。`fly.toml` の稼働設定や deploy を変更するコマンドではない。

開発用 command 同期は従来の `.env.local` / `summit.config.yml` を使い、引数を CLI に渡す。本番用はこれらを暗黙に読まず、`DISCORD_TOKEN`・`DISCORD_APPLICATION_ID`・`DISCORD_GUILD_ID` だけを必須入力にする。DB / member / schedule 設定は不要で、両経路とも Fly 内では拒否する。成功・結果不明と終了管理は [Discord 規約 §7](./discord-rule.md#7-slash-command-同期)、実操作は [本番同期 SOP](./operations/README.md#本番discordコマンド同期)。

### 文書検証の入力

Git index から対象一覧を得て、作業中の内容を読む。未追跡設定・生成物を自動走査しない。新規 file は `--include <repository 内のパス>` で加え、複数なら option を繰り返す。明示された Markdown link / anchor の参照先と必須の正本・adapter の存在も検査する。`docs:sync-agent` は検査を含むため、後続の文書差分がなければ重ねて実行しない。

文書 script は外部依存を必要としない。pnpm が依存関係の再 install を要求する場合は、その command の実行時だけ `pnpm_config_verify_deps_before_run=false` を指定できる。固定 runtime を使い、repository / global 設定は変更しない。

## 3. TypeScript の境界

- strict、exact optional property、unchecked indexed access、`erasableSyntaxOnly` を弱めない。外部入力は `unknown` から zod / guard で narrow し、`any` を使わない。
- `as` は型情報を構造的に回復できない境界に限定する。二重 cast・`as never` で不一致を隠さない。必要な抑制には理由・範囲・撤去条件を残し、`@ts-ignore` を常用しない。
- union は discriminant と `assertNever` で閉じる。public function / repository / service / handler は return type を明示し、config / DTO は readonly、constant map は `as const satisfies` を優先する。
- 独立した I/O だけを並列化する。Promise の追跡、fire-and-forget の catch、失敗時の settlement は [Architecture §5](./architecture.md#5-非同期処理とエラー) に従う。
- Effect は `effect/Effect` 等の公開 subpath から namespace import し、非 bundle 実行で不要な barrel 初期化を避ける。

## 4. File の責務

配置と依存方向は [Architecture §2](./architecture.md#2-module-の所有範囲) に集約する。一 file 一責務を基本とし、300 行超は分割の review 対象であって自動失敗ではない。barrel は意図的に public surface を制限する場合に使い、named re-export を優先する。

## 5. Naming

業務語彙は requirements、DB row 型は schema inference に合わせ、意味のない類義語・型 alias を増やさない。type は PascalCase、file は camelCase.ts を基本とし、既存の責務 suffix を維持する。日付文字列は `*Iso`、Date は suffix なし。

| Prefix | 約束する意味 |
|---|---|
| `build*` / `render*` / `get*` | pure な値構築 / 表示変換 / 必ず値を返す accessor |
| `find*` / `send*` | DB read で 0〜N 件 / Discord・HTTP・DB write 等の副作用 |
| `try*` / `handle*` / `run*Tick` | 条件不足で no-op / entry handler / scheduler の一回実行 |
| `create*` / `upsert*` | entity 作成 / 更新または作成 |
| `settle*` / `transition*` | deadline・投票後の収束 / 一段の状態遷移 |

`build*` に I/O を入れず、意味の曖昧な `refresh*` は read / update / send に分ける。

## 6. Comment

名前と型で伝わらない理由、不変条件、競合、一時互換を残す。code から読める WHAT / HOW、実行値・schema・業務仕様の複製、古い外部 link だけの説明は増やさない。

TSDoc は module 境界を越える export または非自明な contract に使い、本文は簡潔な英語、業務説明の `@remarks` は日本語でもよい。自明な `@param` 列挙は不要。通常 comment は日本語と検索可能な prefix を使う。

| 観点 | Prefix |
|---|---|
| 判断・不変条件 | `why:`、`invariant:`、`source-of-truth:` |
| 競合・状態 | `race:`、`idempotent:`、`state:`、`unique:`、`tx:` |
| 時刻・外部境界 | `jst:`、`iso-week:`、`ack:`、`single-instance:`、`deploy-window:` |
| 秘匿・互換・回帰 | `redact:`、`secret:`、`compat:`、`regression:` |
| 未確定仕様 | `todo(ai):`。文書索引の競合解消規則に従い、PR の要確認事項と対応 |

module preamble は file 名で分からない横断責務がある場合だけ短く置く。装飾区切り・目次・乖離した説明を残さない。互換処理の撤去条件は対応する設計文書に持つ。

## 7. Environment と secret

local secret は `.env.local`、commit 対象の `.env.example` は placeholder のみとする。非 secret の user 設定は既存の `*.config.yml` 追跡方針に従う。読取・出力の許可は AGENTS、parse 済み設定と log の実装境界は [Architecture §7](./architecture.md#7-設定と観測)。

env 入口は注入された環境の検証に限定し、local file は package command の `dotenv` で明示的に読む。monitor URL も機密値として扱い、Fly secret の unset / 上書きは [rotation runbook](./operations/secrets-rotation.md) と対象操作の権限に従う。

## 8. Local DB

momo-db の compose / migration を使い、Summit に migration tool を再導入しない。週次 flow のやり直しは `pnpm db:reset`、member も消す必要がある場合だけ `--all` を付けて、その後 seed する。`docker exec` / `psql` の手動 TRUNCATE で代用しない。

seed / reset / scenario は [localDatabase](../scripts/dev/localDatabase.ts) の PostgreSQL host guard を通す。seed は起動時と同じ member reconcile を使い、配列順で過去の identity を変えない。

## 9. Git と PR

開始時と commit 前に branch・worktree・staged diff を確認する。既存ユーザー差分を編集・revert・stage せず、今回の対象を明示して stage する。同じ file に既存差分がある場合は hunk を分けて確認する。

commit を依頼されたら、必要な gate と staged diff を確認して実行し、hash と完了状態を報告する。message は英語の Conventional Commits。commit の許可を push・merge・deploy に広げず、明示依頼なしに履歴を書き換えたり無関係な差分を破棄したりしない。

PR 本文は日本語で、問題・変更後の挙動・理由・検証結果を先に書く。[template](../.github/PULL_REQUEST_TEMPLATE.md) を使い、command の pass / fail / 未実行と warning、選んだ gate と実行できない理由を区別する。重要な仮定・要確認事項・運用影響・risk・更新した正本だけを具体的に添え、空の見出しを埋めるための文章は増やさない。

業務仕様変更と文書構成変更など、異なる判断を要する変更は commit / PR を分ける。設計変更は現行の正本を同時に更新し、判断理由・非採用案・再評価条件を残す。完了済み計画や番号付き履歴文書は蓄積しない。

Linear の実装・確認が完了し、merge で Done にする場合は PR に `Fixes <issue ID>`。merge 後も追加作業・受入確認が残る場合だけ `Refs <issue ID>` と残作業を書く。この記法はチケット更新・外部メッセージ・merge 自体の権限を与えない。
