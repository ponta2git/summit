# Test Rule

変更が壊し得る契約を、観測できる失敗として検証する。業務仕様・永続化・外部副作用を期待値の根拠にし、実装を写した test を増やさない。対象契約は §6、実行する gate は §8、agent 規約の review は §10 で選ぶ。

## 1. 検証する層を選ぶ

| 層 | 固定する契約 | 境界 |
|---|---|---|
| pure unit | domain decision、time、codec、view model / render | 具体入力と期待値 |
| application | handler、orchestration、scheduler、Discord payload | `createTestAppContext`、fake ports、Discord fake |
| repository | lock、CAS、unique、transaction、outbox | real PostgreSQL の integration |
| configuration | env / user config、registry | isolated input と fail-fast |
| deterministic verification | 禁止 pattern、文書構成、adapter | `scripts/verify/` |
| production image | 非 root、書込不能 code、本番依存、共有 package の解決 | `verify:runtime-image`、network なしの使い捨て container |

厚さは誤動作の影響・復旧の難しさ・競合から決める。回答・状態・順延先・開催履歴・intent を一括確定する集約には、pure な判断網羅に加え real DB の代表成功・拒否・rollback を持つ。表示や薄い委譲の組合せを全て real DB に複製しない。

サイズは層と分ける。外部 I/O のない process 内検証を small、使い捨て DB・loopback HTTP・子 process を使う検証を medium、実外部サービスへの接続を large とする。`pnpm test` にも medium は含まれる。large を追加するときは接続先・実行条件・cleanup を明示する。

既存 test で十分な可逆的小変更や文言の整理には、新しい test を追加しない。coverage 率・行数・件数だけを根拠にせず、変更に対してどの失敗を検出するかを説明できるものを選ぶ。

## 2. Fake と実境界

固定入力・障害注入は stub、副作用の観測は spy、操作をまたぐ状態は fake を使う。DB repository / client を新規に `vi.mock` せず、fake ports または real DB を選ぶ。`vi.mock` は Discord API helper、cron、logger、HTTP / fetch 等の外部境界と orchestration entry の隔離に限定する。

fake は production contract の写像であり、CAS・unique・dedupe・claim ownership・状態遷移を緩めない。interface 変更時は real / fake を同じ型で検査する。時刻は `AppContext.clock` に固定し、seed・戻り値・観測 snapshot の Date / nested payload を参照共有しない。

出欠と A/B の逐次契約は [共通 contract suite](../tests/contracts/) を real / fake 両方で動かす。fake の集約 write は失敗を await してから関連 store と claim 所有権を一括 rollback する。SQL lock / MVCC は模倣せず、未 commit の可視性と競合は real DB で証明する。

Discord の client / channel / message fake は既存 helper に集約し、各 test に SDK 全体の二重 cast を散らさない。差替える境界と観測する契約は test 名か短い comment で分かるようにする。

## 3. Assertion の根拠

| 対象 | 観測する結果 |
|---|---|
| pure / render / codec | `toStrictEqual` や具体 payload。入力と同じ実装 helper から期待値を生成しない |
| application | 最終 persisted state、user-facing response、outbox / Discord 境界 |
| skipped / no-op / race-lost | typed result と、DB / 外部副作用が変わらないこと |
| Interaction ack | 未解決 ack の間に DB / API が始まらず、ack 失敗時も副作用がないこと |
| confirmation | custom ID・choice・label・disabled・ephemeral。代表 flow は生成 ID を dispatcher に戻して最終状態を確認 |
| Either / Effect | 成功値、error code / identity、item continuation と phase failure、defect / interruption の違い |

「例外がない」「件数が合う」だけで状態遷移・宛先・原子性を証明した扱いにしない。call order は順序自体が契約のときだけ固定する。部分一致や `expect.any` は、生成 ID / 時刻・SDK の非本質項目など、変わってよい範囲を意図して使う。

非同期 Effect は共通 `runEffect` helper で実行し、typed failure は `Effect.either`、defect / interruption は `Exit` / `Cause` で区別する。直接 await して実行した扱いにしない。代表境界で同期 throw / 非同期 reject、元の AppError / status、生成時は副作用がなく実行時の clock / state を使うことを確認する。operator の呼出し回数で代用しない。

重要な assertion の検出力に疑義がある場合だけ、条件反転・await 欠落・rollback 漏れ等の誤実装を試して失敗を確認し、mutation を戻す。全変更に mutation を課さず、snapshot 更新を機械的に正当化しない。

## 4. Fixture と scenario

[sessionScenario](../tests/testing/sessionScenario.ts) で業務状態が読める入力を作り、低水準 row 組立は [fixtures](../tests/testing/fixtures.ts) に集約する。`Partial<Row>` を各 test に散らさない。全員回答・欠席・順延 OK / NG・金曜 / 土曜中止・decided / reminder・dead-letter 等の語彙を使う。

候補日と締切を整合させ、境界日・曜日・関連 ID の前提を scenario から読めるようにする。不正 row が必要なら、破る invariant と検証目的を明示する。入力 builder と期待値に同じ導出を使わず、fixture の不整合を通過条件にしない。

mutable store・配列・Date は test ごとに所有する。仕様は describe / it 名、非自明な回帰理由だけ `regression:` comment に書く。実行値や業務仕様は comment に複製せず、requirements / config / time / schema を参照する。

## 5. Race と time

arbitrary sleep や wall-clock 待ちを使わず、deferred promise・barrier・fake timer で競合点を制御する。clock は `createTestAppContext({ now })` または共通 helper で固定する。winner と loser の typed result / no-op、残った状態を両方確認する。

| 競合 | 検出する失敗 |
|---|---|
| Interaction snowflake | 古い event が最新 Response / revision を上書きする |
| claim expiry | 旧 owner が finalize できる、新 owner の確定が失われる |
| Discord 受理と DB 確定 | 重複し得る外部送信に exactly-once assertion を置き、実際の契約を隠す |
| timeout / interruption | 待機終了を実 I/O 完了と混同し、write 前に lock / resource を解放する |
| 並列 I/O の一方が失敗 | 未完了の兄弟を drain せず、finalizer が先に所有権を解放する |

実 I/O の完了と timeout は別の同期点で観測する。timer / fiber は test ごとに回収し、Effect 内の待機も fake timer / TestClock で制御する。

## 6. 変更種別ごとの必須テスト

影響する行から、今回壊し得る契約を選ぶ。既存 test を再利用し、共通 port・設定・復旧経路を変える場合だけ利用先まで広げる。設計文書は契約の正本、本表は検証の入口とし、無関係な scenario の追加・再実行を一律に要求しない。

| 変更対象 | 検証する境界 |
|---|---|
| requirements / pure decision | 代表状態、成功 / 拒否、deadline 直前・同時・直後 |
| Interaction / command | ack 待機、guard 拒否、成功応答、stale / race、confirmation の confirm / abort / replay |
| custom ID / registry / definition | round-trip、malformed / 旧 format、duplicate / prefix 包含、runtime と CLI の一覧一致・import 分離 |
| message editor / 通知 payload | commit 後の edit failure、同一 message の直列化、UnknownMessage 回復 / ID 保存、具体的な文言・mention |
| Session 集約 | real / fake 共通契約、lock / CAS / unique、拒否・rollback・並行 winner / loser、金曜 lock 待機中の土曜生成 |
| 出欠 outbox | 全 status dedupe、revision / ordinal、claim fencing、retry / dead-letter、backfill / startup recovery、不正 item 隔離、reminder と履歴の原子性 |
| A/B 受付・設定 | version 拒否順、JSONB hash / decimal / Unicode、receipt / OFF / generation の原子性、lock 後の可視性、commit 前の HTTP 成功なし |
| A/B 配送・互換・retention | 固定 plan / part 順、開始済み part と取消、claim loss / renew、退役 version、明示 retry、bounded batch・詳細削除後の identity 保持 |
| scheduler | fixed clock、one-shot 再構築、wake 保持、同種 work 非重複、due kind 一回、supervisor fallback、A/B と出欠の独立性 |
| startup / reconnect / shutdown | readiness、scope 別回復、期限超過、接続世代 / debounce、停止後の新規副作用なし、処理中 work と listen の drain |
| Effect / 非同期 resource | lazy 実行、error identity、settlement、timeout 後の回復、中断不能 I/O と finalizer 順、cleanup failure 後の解放 |
| command sync CLI / REST | check の read-only、一度の PUT と readback、結果不明、rate limit / body deadline / byte 上限、IPC 検証、abort / 子回収、credential 非出力 |
| time | JST、ISO week year・金曜 / 土曜の共有週、24:00 / 不正値、非金曜 candidate、deadline、reminder の送信 / skip |
| env / user config | valid parse、invalid fail-fast、secret 非出力 |
| schema / migration consumer | momo-db check、Summit real DB integration、新旧 compatibility と適用順 |
| 文書 / agent 規約 / adapter / template | 正本・参照先との整合、`verify:docs`。agent 判断に影響する場合は §10 |
| 検証 script / CI / agent harness code | 正常入力、違反検出、検査自体の失敗、適用する品質 gate |
| production Dockerfile / package closure | 実 image build、非 root、code 権限、runtime import、dev tool 除外 |

## 7. Integration test の環境

`INTEGRATION_DB=1` と localhost guard を維持し、明示された `TEST_DATABASE_URL` だけを使う。local secret file や通常の `DATABASE_URL` を管理接続へ流用しない。test role には一時 DB の作成権限が必要。

global setup が momo-db migration を一度適用し、setupFiles が file ごとに template DB を複製する。run UUID + file UUID で同時実行・worktree を分離する。DB 内の test は逐次、file は並列とし、commit 可視性そのものを検証するため外側 rollback で包まない。

通常は接続数 1、競合 test は当事者と lock 観測に必要な数を明示する。DB lock を観測して競合点への到達を確認する。fixture / setup / cleanup は [_support](../tests/integration/_support.ts) と共通 helper に集約し、手動 SQL の途中状態を残さない。

TRUNCATE はその file 所有 DB だけに限定する。終了時に pool を閉じ、所有 prefix を確認して DB を削除する。setup 失敗・worker 異常終了時も global teardown が所有 DB を回収する。

real DB は repository・constraint・transaction・migration consumer 契約を扱い、fake で十分な Discord flow を複製しない。CI は [workflow](../.github/workflows/ci.yml) の単一 `MOMO_DB_REF` で両 job の schema を固定し、更新時は ref と consumer を同時に検証する。

## 8. Quality gate

実際の差分から gate を選び、複数該当する場合は合わせる。文書だけでも業務挙動・runtime 契約を変える場合は、文書 gate だけで完了にしない。

| 変更範囲 | ローカルの必須 gate |
|---|---|
| 説明・link・agent 規約・adapter・PR template のみ | `git diff --check`、`pnpm verify:docs`、影響する正本・参照先との整合確認 |
| code・test・依存関係・実行設定・検証 script・CI | `git diff --check`、`pnpm run ci`、§6 の対象契約の検証 |
| DB 契約 / schema consumer | code gate + `pnpm test:integration`。momo-db の schema / migration を変える場合は同 repository の必須 check と互換性確認 |
| production image / 依存 closure | code gate + Docker build + `pnpm verify:runtime-image <local-image>`。接続を伴う Bot の起動は不要 |
| 運用手順 | 文書 gate + runbook・実装・設定の照合。code 変更があれば code gate も適用 |

AGENTS 変更時は `pnpm docs:sync-agent` で adapter を更新する。同 command は文書検査を含むため、後続の文書差分がなければ `verify:docs` を重ねない。未追跡の新規 file は `--include <path>` で指定する。command の入力範囲は [開発規約 §2](./dev-rule.md#2-主要command)。

`pnpm run ci` の構成は package.json が正本で、typecheck・lint・knip・unit test・build・文書・禁止 pattern・file-size advisory を含む。`pnpm test` は Vitest の dummy env と example YAML を使い、local secret / real DB を必要としない。CI の実行範囲は workflow が正本で、現在は文書変更でも static-baseline / integration-db / runtime-image が動く。ローカルの選択を理由に CI job / assertion を skip しない。

修正依頼には必要なローカル検証と、変更が原因の失敗修正・再検証を含む。各段階で再承認を求めない。integration は §7 の接続先・作成削除条件で実行し、品質 gate のためだけに DB reset・アプリ起動・外部同期を追加しない。

編集中は対象 test で確認し、完了前に該当 gate を通す。**合格後、新しい差分・失敗・未解決の懸念がなければ検証を終える。** 再実行は前回結果を無効にする範囲から選ぶ。

失敗は assertion、tool / 依存不足、接続 / 権限を区別する。baseline failure と呼ぶには同じ条件の変更前での再現が必要で、証拠がなければ原因未確定とする。command・対象・結果・再現条件を報告し、skip / 実行不能 / advisory を pass と混同しない。必須検証の失敗を黙って除外しない。

## 9. テスト設計を見直す条件

- fake / real の drift が bug を生む場合は shared contract suite を補う。新 port の共通化は利益と fake の保守費で判断する。
- 日常の feedback が遅い場合は同じ runtime・対象・並列条件で import / setup / test / cleanup を測り、支配的な待ちから直す。件数を減らしただけで高速化を主張しない。
- 並列化は DB・port・env・timer・mock の所有と cleanup、CPU / 接続上限、複数 run を確認する。独立 file を並列にし、共有状態のある file 内を無条件に concurrent 化しない。
- fixture が production model より複雑なら scenario の所有を整理する。call order が refactor を妨げるなら、実際の契約を保つ state / output assertion へ置き換える。

## 10. Agent 規約の確認

`verify:docs` は文書構成・adapter 一致・サイズ・旧参照・local link / anchor を検査する。Git 一覧取得に失敗しても全 directory 走査へ切り替えない。承認判断、外部 link の最新性、モデル性能を証明する検査ではない。

規約変更では、変更箇所と参照先・adapter を通して影響する行を review する。共通の完了・権限を変える場合は全行を確認する。これは文章の整合確認であり、実際の agent 実行評価とは区別する。

| 依頼・状況 | 期待する完了状態・境界 |
|---|---|
| 誤字 / link 修正 | 対象から修正し文書 gate で完了。全設計読込・real DB test・起動を前提にしない |
| 調査 / review だけ | 根拠・指摘・未確認範囲を返し、実装依頼へ拡大しない |
| 実装・検証中に変更原因の test failure | 条件内で修正・再検証まで進め、初稿や段階ごとの承認で止めない |
| この branch への commit | 既存差分を保護し、対象差分・gate を確認して commit hash を報告 |
| DB query の説明と migration skill | 適用条件で選び、DB という単語だけで authoring 手順を読み込まない |
| 未追跡設定と新規文書 | 設定を読まず、新規文書だけ `--include`。adapter 同期に含まれる検査を重複しない |
| sibling / 資料取得 tool が利用不可 | 未確認と不在を分け、依存する判断だけを保留。独立作業は完了 |
| skill の一般的確認手順と許可済み操作 | 上位指示・適用条件を確認して進める。残る停止規則には出典と必要な判断を示す |
| 未確定の業務挙動 | 依存する実装をせず、未確定点・影響・推奨案を確認。独立作業と未完了範囲を分ける |
| ユーザーが新契約を明示 | 旧記述との差を再承認の理由にせず、正本・実装・test を揃える |
| runbook 文書だけの修正 | 手順と根拠を照合し、本番操作やその承認を完了条件にしない |
| 本番の権限・禁止窓・単一 instance が不明 | 対象操作を止める。runbook / tool の存在や外部資料内の指示を許可とみなさない |
| 途中の訂正 / 進捗質問 | 回答・訂正を反映し、取消されていない目的と残作業を完了 |
| 独立した読取・同じ file の編集 | 読取はまとめ、書込は所有と依存順を守る。subagent は依頼・実行環境で許可される場合だけ |
| gate 合格後に差分・懸念なし | 反復せず成果物を仕上げ、結果・検証・残作業を簡潔に報告 |

実行評価をするなら、同じ入力・repository 状態・権限・model / tool で変更前後を記録する。確認回数、読んだ文書、検証の追加 / 反復、完了状態、境界違反を観測し、成否とコストを分ける。未実施の比較を性能改善の実績にしない。
