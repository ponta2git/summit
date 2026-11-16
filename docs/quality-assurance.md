# Quality assurance model

品質の横断レビューで使う設計上の不変条件、攻撃・障害モデル、検証根拠を管理する。対象は [ISO/IEC 25010:2023](https://www.iso.org/standard/78176.html) の性能効率性・信頼性・セキュリティ・保守性。規格認証や欠陥の不存在を表す文書ではない。境界・資源上限・永続化・テスト基盤を変えたときに対応行を更新する。業務仕様は [requirements](../requirements/base.md)、詳細契約の所有者は [文書索引](./README.md#2-文書の責務) とする。

## 1. 前提から導く全体設計

対象は専用 guild / channel、固定メンバー、単一 Bot process、共有 PostgreSQL。外部入力は Discord Interaction、private HTTP、注入設定と運用 CLI の応答であり、DB と Discord の間に分散 transaction はない。

| 境界 | 設計上の不変条件 | 所有者 |
|---|---|---|
| 受付 | 認証・構文・readiness・容量を確認し、所有した処理だけ開始する | Discord dispatcher、HTTP receiver |
| 業務判断 | pure decision と一つの時刻 snapshot で状態・締切を決める | domain、time、orchestration |
| 永続化 | 状態・回答・revision・intent は同一 transaction、SQL と lock 待ちには期限 | SessionCommands、runTransaction |
| 配送 | durable identity、順序、期限付き claim、heartbeat、begin / finalize の CAS | notification repositories、scheduler |
| 表示 | commit 後の wake を先に行い、再描画の失敗で確定済み操作を失敗へ戻さない | feature editors、messageUpdates |
| 保守 | 一通知・一 Session の原子性を守り、別 batch では lock を解放する | retention、claim recovery、startup recovery |
| 停止 | 受付を止め、すべての owner を停止・drain し、実 I/O と最終 destroy を待つ | lifecycle、shutdown |
| 実行物 | 非 root・本番依存・読取可能な code のみ。build context は許可リスト | Dockerfile、runtime image gate |

この責務分割を全体の設計として採用する。既存の pure decision / ports / PostgreSQL outbox は不変条件に合致するため維持し、専用 broker・分散 leader・全面的な DI framework への置換は行わない。複数 instance や多 guild 化では容量・順序・leader・運用を一体で再設計する。

## 2. 敵対的レビューと回帰根拠

重大度は Summit の前提で評価する。高は受付・配送・停止の継続性や所有権を破るもの、中は特定の失敗・悪性入力で契約を破るもの、低は境界値・診断・保守上の欠陥。以下は検出した問題と、それを防ぐ現行設計の対応である。

| 特性 / 重大度 | 旧挙動を破る条件 | 現行設計・回帰テスト |
|---|---|---|
| 性能・高 | DB / Discord 停滞中に Interaction を連打し、Promise / DB queue を増やす | 通常受付と拒否応答の有限枠、stop / drain / 枠回収。[100件 burst](../tests/discord/interactionAdmission.test.ts) |
| 性能・高 | 本文上限内の HTTP を極小 chunk に分割し、Buffer 数でメモリを増幅 | byte 上限内の連続 buffer。[分割本文](../tests/notifications/http.body.test.ts) |
| 性能・保守性・中 | 週次予定の確定で不要な往復を行い、出欠claimで未使用列を転送する | 成功時の週次停止は週情報のSQLを3文から1文、自動生成の週情報書込みは2文から1文へ集約。出欠読取の通知親列は24列から13列に限定。[週次予定](../tests/integration/sessionCommands.contract.test.ts)、[配送読取](../src/db/repositories/outbox.storage.ts)。SQL・列数の削減であり実環境の遅延改善率は未測定 |
| 性能・セキュリティ・高 | 最大本文を同時受付し、JSON 内に大量の空 object・深い配列・不正要素を入れる | 受付全体の byte 予約を DB settlement まで保持。parse 前の構造・深さ制限と配列の最初の不正での打切り。[受付容量](../tests/notifications/http.lifecycle.test.ts)、[悪性構造と8MiB近傍の正当入力](../tests/domain/notificationJson.test.ts) |
| 性能・セキュリティ・高 | 小さな指数表記を DB で巨大な decimal へ展開させる、旧 ID の内容照合を同時に行う | SQL 前の数値展開作業量と SQL 内の正規化 byte 数を別々に制限。旧容量での内容照合もストレス対象とする。[数値予算](../tests/domain/notificationNumericBudget.test.ts)、[実 PostgreSQL との境界比較](../tests/integration/notificationNumericBudget.test.ts) |
| 性能・信頼性・高 | 上限内の長いメモや Markdown 記号だけのメモで、正規表現の作業領域を増幅させる | hash は有限走査と逐次更新、escape は断片単位。保存 identity と全文・Unicode を維持。[hash](../tests/notifications/hash.test.ts)、[実 DB の最大近傍](../tests/integration/resultNotifications.transactions.test.ts)、[escape 境界](../tests/features/result-notifications/text.test.ts) |
| 性能・中 | 完了 Session を蓄積し、wake ごとに全件 CASE 集計を実行させる | status / 時刻 index の先頭を別々に取得。[1万件の実行計画](../tests/integration/schedulerQuery.performance.test.ts) |
| 性能・信頼性・高 | 保守 backlog で family lock を保持し、配送 heartbeat を待たせる | 件数・pass 上限と batch ごとの commit、集合 SQL。[retention](../tests/integration/notifications.retention.test.ts)、[real / fake の保守上限](../tests/contracts/attendance.ts) |
| 性能・信頼性・中 | 起動時 dead-letter の全 ID を IN 引数・メモリに展開する | Session の keyset page、DB 内の集合更新、同一チェーン原子性。[複数ページ](../tests/integration/outbox.recovery.capacity.test.ts) |
| 性能・信頼性・高 | A/B 受付の連続で起動を延期する、処理中の wake を失う、即時 wake が障害 backoff を破る | 次の timer turn へ重複要求を集約し、最早起動・処理中 wake・回復期限を保持。[dispatcher](../tests/scheduler/resultNotifications.test.ts) |
| 性能・信頼性・中 | 長文分析2件が後着 OCR を待たせる、OCR の連続到着が分析・旧巨大通知を追い越す | 種別交互 claim、complete 後の譲渡、最古の予算待ちと旧巨大通知の単独配送。[公平配送](../tests/scheduler/resultNotifications.test.ts)、[実 DB claim](../tests/integration/resultNotifications.claim.test.ts) |
| 信頼性・高 | 譲渡と heartbeat が競合する、譲渡 rollback・commit 後の応答喪失で試行数や送信済み投稿を失う | 共通 gate、token fencing、譲渡時の試行予算相殺、固定 snapshot と配送済み番号による再開。[real / fake 契約](../tests/contracts/resultNotifications.ts)、[実 DB 譲渡](../tests/integration/resultNotifications.yield.test.ts) |
| 信頼性・高 | 出欠の hint / tick / 次時刻取得を一度だけ失敗させる | 有限 backoff、成功 reset、supervisor による再開。[controller recovery](../tests/scheduler/controller.recovery.test.ts) |
| 信頼性・高 | Discord の rate-limit 待機で出欠 claim の期限を超える | 両 family の共通 heartbeat、期限切れ owner の復活禁止、renew の settlement。[配送所有権](../tests/scheduler/outboxWorker.ownership.test.ts)、[real / fake 契約](../tests/contracts/attendance.ts) |
| 信頼性・中 | Discord 受理後の DB 失敗で短時間再送する | 通知 / part の安定 nonce、begin / finalize fencing。[配送所有権](../tests/scheduler/outboxWorker.ownership.test.ts) |
| 信頼性・保守性・高 | claim 待機中の停止、準備の同期失敗、配送終了と枠補充を競合させる | 共通容量台帳で予約と完了待ちを持ち、Scope が実行を所有して settlement 後に解放。出欠 batch と A/B の随時補充は別方針。[容量](../tests/notifications/delivery.capacity.test.ts)、[claim と停止](../tests/scheduler/resultNotifications.test.ts) |
| 信頼性・性能・高 | SDK の送信・channel 取得が45秒を超え、20分未完了になる | 論理配送と実未完了 I/O の owner 和集合で2件・元本文512 KiBを予約。旧巨大通知の単独予約、遅延成功、stop / drain、警告数と実完了後の再開を[障害注入](../tests/scheduler/resultNotifications.pendingIo.test.ts)・[台帳](../tests/notifications/resultIo.test.ts)で検証 |
| 信頼性・高 | renew の応答喪失・未応答、clock jump、同期処理によるtimer遅延 | 独立した期限監視と直前guard、uncertain中の新規停止、同じclaimの期限内回復、停止中のDB所有を[heartbeat](../tests/scheduler/claimHeartbeat.recovery.test.ts)と[実DB](../tests/integration/notifications.leaseClock.test.ts)で検証 |
| 信頼性・性能・高 | 通知DB応答喪失、family gateの占有、待機中stop | family 2/全体3の実未settle上限とproducer 34件、期限優先/FIFO、未開始HTTP 5秒、stop時no-opを[待機列](../tests/notifications/databaseAdmission.test.ts)・[実DB](../tests/integration/notifications.admission.test.ts)で検証。通知以外のDB待ち全体が消える保証ではない |
| 信頼性・性能・高 | 次時刻照会の応答喪失、空き枠がある状態で期日を跨ぐ | [pump進捗](../tests/notifications/resultRuntime.progress.test.ts)で20分の単一照会所有・警告上限・復帰と、期日を跨いだ候補のtimer再設定を検証 |
| 信頼性・性能・高 | 受付待機で解析木を保持する、新規検証失敗が既存duplicateを壊す | 同期preparationから元JSON・最小DTO・固定結果だけを渡す。[DTO境界](../tests/notifications/receiptPreparation.test.ts)と[エラー優先順](../tests/integration/resultNotifications.preparation.test.ts)を検証。duplicateの追加CPUは性能比較の対象 |
| 信頼性・高 | stop / drain の先頭で同期 throw、destroy を遅延・reject させる | 全 owner を呼び、非同期 destroy 完了を待つ。[lifecycle](../tests/runtime/lifecycle.test.ts)、[shutdown](../tests/shutdown.test.ts) |
| 信頼性・中 | metrics を失敗させる、cron 登録を途中で失敗させる | 観測と回復の失敗分離、登録済み task の回収。[cron lifecycle](../tests/scheduler/cron.lifecycle.test.ts) |
| 信頼性・高 | Session row / advisory lock を保持して出欠 transaction を待たせる | transaction-local の SQL / lock deadline、rollback 完了後の再利用。[実 DB 期限](../tests/integration/transactionLimits.test.ts) |
| 信頼性・高 | DB commit 後に公開 edit を失敗・遅延させる | commit → wake → best-effort edit。legacy CANCELLED / startup も同じ区別。[commit 後の失敗](../tests/discord/committedTransitions.test.ts)、[起動回復](../tests/scheduler/reconciler.transitions.test.ts) |
| 信頼性・中 | 開催確定後の編集で clock を進め、reminder skip を誤判定させる | 判定・必要な開催履歴の確定に同じ snapshot を使う。[確定処理](../tests/discord/committedTransitions.test.ts) |
| 信頼性・中 | `/ask` の二度の clock 読取を週境界にまたがせる、別 context を同時実行 | 一つのsnapshotとDBでの作成判定。in-flight集合は停止時の待機だけを所有し、別contextの結果を再利用しない。[募集](../tests/discord/ask/send.test.ts) |
| 信頼性・保守性・中 | 募集判定後にgate外writerが週次停止を確定する、不正な通知ownerが混在する | 条件付きupsertの失敗で募集全体をrollback。通知ownerをunionと明示検証で限定し、不正な旧行だけFAILEDへ隔離。[募集競合](../tests/integration/sessionCreation.race.test.ts)、[通知隔離](../tests/integration/outbox.isolation.test.ts) |
| 信頼性・中 | `/status` の過去警告を大量に蓄積し、本文上限を超える | 行単位の制限・省略件数・現在週と合計の保持。[status](../tests/features/status-command/viewModel.test.ts) |
| 信頼性・低 | 実在しない日付、0〜99年、完了済み開催の再描画 | 厳密な ISO date と確定時刻の保持。[日付](../tests/time/jst.test.ts)、[view model](../tests/discord/ask/viewModel.test.ts) |
| 信頼性・保守性・低 | 表示 test と計算用の負定数を共有し、「-15分後」を正当化 | lead は正値、減算は計算箇所だけ。独立した期待文面。[reminder](../tests/features/reminder/delivery.test.ts) |
| セキュリティ・中 | 表示名へ everyone / role / 設定外 user の mention を埋め込む | 既定禁止と固定 member 許可リスト、edit も明示。[mention policy](../tests/discord/mentionPolicy.test.ts) |
| セキュリティ・中 | 初回・再利用・pipeline の header / body を完了せず接続や受付枠を占有する | 接続・応答完了からの header 期限、Node の pipeline 期限、有限 idle / 要求数、接続32・受付4の上限、未読本文と異常応答の切断、stop 時の回収。[connection](../tests/notifications/http.connections.test.ts)、[再利用と pipeline](../tests/notifications/http.keepAlive.test.ts) |
| セキュリティ・中 | 運用 CLI に巨大・不正 UTF-8・終わらない応答を返す | 実 byte 上限、本文までの deadline、stream cancel。[CLI response](../tests/notifications/cli.response.test.ts) |
| セキュリティ・中 | 秘匿文字列を含む不正 YAML / warning を設定する | 純粋 parser に集約、byte / alias 制限、安全な固定診断。[YAML](../tests/config/userConfig.yaml.test.ts) |
| セキュリティ・低 | Authorization の重複や不正 Bearer token を使う | 単一 header と共通 token 構文、origin-form の要求。[HTTP](../tests/notifications/http.test.ts)、[env](../tests/env/env.test.ts) |
| セキュリティ・保守性・中 | root と開発依存を含む image をそのまま配布する | 本番専用依存 stage、非 root、許可された build context。[runtime gate](../scripts/verify/runtimeImage.ts) |
| セキュリティ・保守性・中 | `.ts` import の違反や検索障害で gate を迂回する、検知した credential を診断で再出力する | 対象 path 明示・両 extension 対応・検索失敗の検知、原文を出さない固定診断。[検証器自身の回帰](../tests/verification/forbiddenPatterns.test.ts) |

追加修正が不要だった境界にも、次の検証を維持する。

| 確認範囲 | 根拠 |
|---|---|
| guild / channel / actor、custom ID、confirmation replay、ack 前 DB 禁止 | [Discord tests](../tests/discord/) |
| Session lock / unique / CAS、同時取消と順延、回答と intent の rollback | [attendance integration](../tests/integration/attendance.contract.test.ts)、[取消競合](../tests/integration/cancelWeek.postpone-race.test.ts) |
| A/B identity / version / lossless hash、OFF / generation、取消と開始済み part | [result contracts](../tests/contracts/resultNotifications.ts)、[実 DB](../tests/integration/resultNotifications.transactions.test.ts) |
| ready 世代、reconnect、startup / shutdown listen 競合、Effect settlement | [startup](../tests/startup/)、[runtime](../tests/runtime/)、[HTTP lifecycle](../tests/notifications/http.lifecycle.test.ts) |
| token / DB URL / 外部 cause の非出力、同期 CLI の権限・IPC・子回収 | [redaction](../tests/logger/redact.test.ts)、[sync](../tests/discord/commands/) |
| schema 所有権、migration 適用、CI の sibling revision 固定 | [DB 規約](./db-rule.md)、[CI](../.github/workflows/ci.yml) |

## 3. 品質特性ごとの判定

| 特性 | 評価する性質 | 合格根拠と評価限界 |
|---|---|---|
| 性能効率性 | 応答遅延、保持資源、容量・公平性 | index の実行計画、入口と保守の上限、連続 wake 下の開始保証。[通知性能レポート](./performance.md)でlocal DB・本番imageの上限負荷を計測。実 Discord / Neon の p95・p99 は未計測で、速度改善率を推定しない |
| 信頼性 | 通常動作、可用性、故障隔離、復旧 | state / intent の原子性、lease、backoff、再起動回復、stop / drain の障害注入。単一 instance と外部停止の限界は残る |
| セキュリティ | 秘匿、完全性、真正性、追跡可能性、攻撃への耐性 | actor / token 分離、parameter SQL、ログ非出力、資源制限、least privilege。共有 token の操作履歴は個人の否認防止署名ではない |
| 保守性 | module 境界、再利用、原因分析、変更容易性、テスト可能性 | parser / heartbeat / lifecycle と配送の容量・source・Strategy・definition の責務分離、real / fake 共通契約、決定論的 race、検証器と実行 image の検証 |

負荷上限の正本は [config](../src/config.ts)・[notification config](../src/notifications/config.ts)、JSON の構造と schema は [payload parser](../src/domain/resultNotificationPayload.ts)。有限であることだけを理由に、すべての最大 payload の組合せが任意の process メモリ容量に収まるとは扱わない。

### 静的解析と実行検証の分担

DeepSource の重大度や件数は調査の入口とし、既存規約への一致も正しさの証明とはしない。変更によって守る不変条件、失敗させる入力、検証で観測する結果を先に決める。指摘の解消はコード修正・根拠付きの例外・別の検証による代替のいずれかで説明し、解析エラー・未実行・未評価をゼロ件へ含めない。ISO/IEC 25010 は評価対象を定める参照モデルであり、lint 合格や coverage 率を規格への適合認証として扱わない。

| 検証 | 主な検出責務 | 補う検証・限界 |
|---|---|---|
| TypeScript・build | 実際の依存関係と strict 設定に基づく型、export、ESM / `.ts` import 契約 | canonical DB consumer と本番 image で公開型・実行時解決も確認。DeepSource が sibling package を解決できない指摘だけで共有 schema を複製しない |
| oxlint | 構文上の欠陥、危険な Promise 利用、環境入口、import の違反 | [設定](../.oxlintrc.json)で有効にした規則が実際の command で動くことを検証。設定に規則名があるだけで型情報を使った検査が実行されたとしない |
| Knip・禁止 pattern・file size | 未使用の依存・公開面、依存方向・危険な操作、責務過大の候補 | 未使用判定を runtime の動的登録と照合する。行数や複雑度は分割の判断材料で、所有権が見えなくなる機械的分割を強制しない |
| DeepSource | PR と baseline に対する別実装の静的解析、Docker / Shell の問題、コードの疑わしい構造 | ローカル gate と同じ入力・対象版ではない。疑わしい行を実装・仕様・test と照合し、PR の新規指摘ゼロと baseline の残存指摘を区別する |
| unit / application・real DB | 故障隔離、実 settlement、原子性・競合、回復と停止、変更に対する検出力 | Promise の文法や型だけでは所有権を証明できない。同期 throw・非同期 reject・遅延・期限切れの境界を制御して検証する |
| 本番 image・容量・profile | 実行物の権限と依存 closure、代表負荷の時間・CPU・保持資源 | 性能指摘を修正する時は入力サイズと呼出し頻度を確認。allocation や漸近量の改善を、未測定の実サービス遅延改善へ読み替えない |

例外は問題のある規則と最小の対象範囲に限定し、理由・代替検証・撤去条件を code または本節へ残す。全件除外・重大度引下げ・空の catch で合格にせず、同じ誤検知が横断する場合は規則の適用範囲を設定で管理する。型や analyzer の更新、対象 API / module の変更、代替検証の失敗で再評価する。DeepSource の抑制方式は [公式仕様](https://docs.deepsource.com/docs/platform/dashboard/repository/issues)を使い、抑制後も別規則の検査対象は維持する。

DeepSource が ESLint 設定の明示的な無効化を読む[公式連携](https://docs.deepsource.com/docs/platform/reference/core-analyzers#eslint-rules--plugins)を使い、[`.eslintrc.json`](../.eslintrc.json)を解析間の調整に限定する。通常の lint command と規則の正本は引き続き [`.oxlintrc.json`](../.oxlintrc.json)。ESLint の別実行系・推奨設定・file 除外は追加しない。共通の規則は root の `rules`、test 固有の例外は `overrides` に分ける。source は TypeScript に統一し、別言語の source を追加する際は委譲先の型検査と適用範囲を再評価する。設定の読み込みと対応規則の反映は対象 commit の DeepSource 再解析で確認し、ローカル lint の合格をその代わりにしない。

| ESLint 連携の範囲 | 委譲する規則 | 残す検証 |
|---|---|---|
| repository の TypeScript | `no-void` | 型情報を使う `no-floating-promises` (`ignoreVoid: false`)・`no-misused-promises`、owner の rejection / settlement test |
| 同上 | `require-await` と TypeScript 版、`consistent-return` と TypeScript 版、`no-invalid-void-type` | Promise / Effect の明示した戻り型、strict typecheck・`noImplicitReturns`、同期 throw・非同期 reject の境界 test。`void` の generic / `this` / cleanup union と意図した Promise interface を保持する |
| 同上 | `id-length` | [命名規約](./dev-rule.md#5-naming)と責務の review。文字数だけで `db`・`tx`・`ctx` 等の意味を変えない |
| `tests/**/*.ts` | TypeScript の `no-non-null-assertion` | fixture の成立条件と拒否経路の test。production の同規則は oxlint で error のまま維持 |
| `send.test.ts`・`tickRunner.test.ts`・`outboxMetrics.test.ts` の3file | `no-empty-function` と TypeScript 版 | 完了済み I/O fake、空の仕事を持つ tick、spy で観測する log の代替だけを許容。対象は設定に完全な path で列挙し、production の handler に適用しない |

この連携では、未使用 code、switch の網羅性、宣言前参照、export 解決、終了処理を一括無効化しない。規則の意味が変わる analyzer 更新、Promise / Effect 契約や fake の用途変更、代替 gate の失敗時には各設定を再評価する。

規則ごとの判断は次の境界に合わせる。個別 occurrence が条件を満たさない場合は例外を広げず修正する。

| DeepSource 規則 | Summit での判断と代替根拠 |
|---|---|
| `JS-0098` (`void` 演算子) | `void` は reject の処理ではない。rejection handler と owner による追跡を確認し、型情報を使った Promise 検査と settlement test で守る。演算子の削除だけを修正としない |
| `JS-0333` (`void` 型)、`JS-0116` (`await` 不在) | `Effect.Effect<void>` と同期・非同期 cleanup の union は契約を表す。[lifecycle](../src/runtime/lifecycle.ts)の `async` は同期 throw を reject 化し全 owner を drain するため必要。Promise interface の fake も `async` を機械的に外さない |
| `JS-W1042` (末尾 `undefined`) | [容量台帳](../src/notifications/delivery/capacity.ts)の `Deferred.succeed(completed, undefined)`、必須 fallback・guard 入力・欠損を注入する fixture は、行単位の理由付き抑制で保持。`Promise<undefined>` / `Effect<undefined>` を `void` へ変えて union を広げない。値を使わない成功 Effect は `Effect.void`、任意引数の真の冗長値は削除できる |
| `JS-0045` (return の統一)、`JS-0047` (default) | 戻り値は明示型と `noImplicitReturns`、union の網羅性は `switch-exhaustiveness-check` と `assertNever` で検証する。[同期 protocol](../src/commands/sync.protocol.ts)等の閉じた union は全 case と `assertNever` の default を持つ。`void` 関数や成功値を返す default にも状態漏れがないことを [lint probe](../tests/verification/lint.test.ts) の違反例で確認する |
| `JS-0357` (宣言前参照) | 宣言順と実行順を区別する。module 初期化後だけ呼ばれる関数と、[配送 runtime](../src/notifications/delivery/resultRuntime.ts)等の初期化後の timer / settlement callback を確認した行だけ `skipcq` で保持する。callback の登録・呼出しが初期化中へ変わる時は再評価し、TDZ や同期呼出しを抑制で隠さない |
| `JS-C1003` (namespace)、`JS-C1001` (import path) | Effect 公開 subpath、Drizzle schema 全体、test の型参照・spy に必要な namespace import の行だけ `skipcq` で保持する。未使用・存在しない export は型検査・Knip・oxlint の import 検査を維持し、将来の import を一括除外しない。native ESM に必要な `index.ts` は保持し、同じ directory への迂回は短縮。[開発規約](./dev-rule.md#3-typescript-の境界)、build と runtime image で検証 |
| `JS-E1007` (export 解決) | sibling の `@momo/db` を [schema](../src/db/schema.ts)から再exportする契約を、固定 sibling revision の typecheck・canonical CI・runtime image で照合。analyzer の解決限界を理由に schema を複製しない |
| `JS-C1002` (短い名前) | `db`、`tx`、`ctx`、`sql` や局所 index は役割が一貫する場合に許容。長さではなく責務と意味で名前を review し、公開 API に曖昧な略語を増やさない |
| `JS-0339` (nonnull)、`JS-0321` (空関数) | production の nonnull 禁止は維持。test の fixture 取得や境界 fake は不変条件・拒否経路を確認して範囲を限定する。空の handler で実エラーを握り潰す実装は許容しない |
| `JS-0263` (`process.exit`)、`JS-0320` (動的 delete) | worker の強制終了・終了後の親回収、test 環境の allowlist 初期化など境界固有の用途を限定する。通常経路の drain・出力 flush を中断する終了、入力に由来する任意 property の削除は別途修正する |
| `JS-R1005` (複雑度) | 分岐数だけで owner・transaction を分断しない。純粋な判断・準備・実行の責務を review し、到達可能な成功・拒否・回復と境界条件を test で確認。責務が増えた場合は再分割を評価 |
| `JS-0246` (文字列結合)、`JS-0097` (escape)、`JS-0117` (Unicode regex) | 単純な値の埋込は template literal、不要な escape は削除。逐次構築や Buffer の作成方式を表記統一のために変えない。regex の match 集合、UTF-16 / code point、巨大 fixture の byte 数を境界 test・容量検証で確認する |
| `JS-0356` (未使用)、`JS-0086` (代入の return)、`JS-0362` (callable interface)、`JS-W1045` (冗長 return)、`JS-W1038` (余分な引数) | 機械的な抑制にせず、不要な公開面・制御構造を修正。callable interface や引数は generic / overload の実際の契約を照合し、型検査と対象 test で変更後の意味を確認する |
| `DOK-DL3008` (apt version pin) | [Dockerfile](../Dockerfile)の Debian package 導入2箇所だけ許容。build 時の更新と image gate を通した immutable image を配備・[復旧](./operations/recovery.md#case-1-bot-再起動直後)の単位にする。再build自体の再現性が必要になれば base digest・apt snapshot・更新自動化を一体で導入し例外を撤去する |

apt package の非固定は更新を取り込むための選択であり、同じ source の再buildが同一byteになる保証はない。逆に版の固定だけでは脆弱性修正の追従を保証しない。前記の例外を残す間も、利用する image と検証した image を同定し、未検証の再buildを復旧用 image の代わりにしない。

### 実行メモリの容量契約

標準の新規受付上限は分析 JSONB text 256 KiB、OCR 16 KiB、HTTP 本文512 KiB、受付全体1 MiB、50試合・16シーズン、名称256・表示名32・メモ150 Unicode コードポイント、分析128投稿とする。OCR の一投稿・既存の文脈名201コードポイント制約も維持する。配送は最大2件、取得・保持中の payload 合計512 KiBに収める。譲渡した配送も heartbeat を含む settlement まで予約し、参照と予約を解放してから補充する。再開待ちの payload を別枠で保持しない。配送枠への割当ては [lanes](../src/notifications/delivery/lanes.ts)、上限値の正本は [notification config](../src/notifications/config.ts)。上限超過は永続受付前に拒否し、旧通知だけは以前の容量・本文・分割を保ち、予算を超える payload を途中譲渡せず単独配送する。

合格条件は [Dockerfile](../Dockerfile) が固定する Node / Debian と allocator 設定の本番 image を256 MiB・swapなしで実行し、標準ケースの cgroup memory peak を192 MiB以下に収めること。通常の小さい通知、最大近傍の Unicode、Markdown 密集の50試合・16シーズン、最大本文の2受付と2配送の重複、旧容量近傍まで数値展開する異内容の4同時受付、5連続 burst、容量・件数超過の拒否を実 DB で検証する。全17通知の全part配送確定まで確認する。旧8 MiB近傍の通知は別 container で単独配送し、全partの計画と最初の一投稿の配送確定、同じ4同時受付を測定する。残りのpartが未配送であることを確認し、全partのDiscord送信負荷を測ったとは扱わない。

最新の実装比較と容量結果は [性能レポート](./performance.md) に記録する。2026-10-02の標準ケースは146.71 MiBで合格。旧巨大通知と4競合受付の別ケースは193.21–196.60 MiBで比較目標192 MiBを超えたが、256 MiB内で完了した。この条件のpeak改善は確認できていない。

2026-09-29、当時の source から build した `summit-runtime-standard-check`（image ID `8843a4795286`）と local PostgreSQL 18で、次の結果を得た。

| ケース | cgroup peak | Node最大RSS | 配送の検証範囲 |
|---|---:|---:|---|
| 新規標準 | 147.30 MiB | 190.18 MiB | 17通知・932投稿を全件確定。5連続burst、拒否9ケース |
| 旧容量の単独配送 | 191.00 MiB | 233.05 MiB | 8,823投稿を計画、先頭1投稿を確定、残り8,822投稿はPENDING |

標準ケースは192 MiB以下の必須目標を達成した。本文は正規化後261,691 byte、HTTPは524,288 byteを使用し、配送時の取得batchは最大523,382 byteだった。両ケースで正規化後8,006,627 byteになる異内容の4受付を重ね、409と保存状態の不変を確認した。旧通知本体は8,382,648 byteで、他の配送との同時claimを許していない。旧ケースも今回の測定では192 MiB以内だったが、目標との差は約1 MiBにとどまる。標準ケースの余裕と同等には扱わない。RSSとcgroupは計上対象が異なるため、値を合算・同一視しない。

fixture 生成と負荷 client は container 外に置き、計測には本番依存・非 root の image と実 DB を使う。起動後の baseline 取得時だけ GC を実行し、負荷中に手動 GC を挟まない。cgroup peak はコンテナ全体の高水位であり、host の負荷生成と別コンテナの PostgreSQL は含まない。Discord への実接続・長期 cache・heap 断片化・出欠の同時最大負荷はこの代表ケースに含まない。

速度・CPU・heap の診断、旧8,823投稿の全件確定、100通知の連続負荷は[性能レポート](./performance.md)で別に測定する。上表は容量gateの結果であり、追加のprofile採取やCPU quota付き計測の数値と混在させない。

payload 上限、配送並列数、文字列処理、Node / allocator、VM memory を変える場合は [容量検証器](../scripts/verify/notificationCapacity.ts) を `pnpm verify:notification-capacity <local-image>` で再実行し、同じimageで `pnpm verify:runtime-image <local-image>` も通してallocator設定と実行環境を照合する。[fly.toml](../fly.toml) は256 MiBとし、標準負荷の検証条件に合わせる。allocator の採用根拠は [性能レポート](./performance.md)、適用後の観測と復旧は [運用手順](./operations/README.md#runtimeのメモリ設定) に従う。設定 file の更新だけでは稼働中 Machine を変更せず、実際の deploy は運用手順と別の権限に従う。

## 4. 残る運用上の境界

- Discord と DB の間の受理後 crash / 長い応答喪失では重複し得る。nonce は短時間の補助であり exactly-once の保証ではない。
- 単一 process の停止中は受付できず、永続受付前の通知は欠落し得る。複数 instance の leader 選出や failover は現在の topology に追加していない。
- 公開 edit は best-effort。保存状態は正しくても表示が古い場合がある。startup の存在 probe は正常な既存 message を必ず再編集する仕組みではない。
- 出欠の一 batch は実 I/O の全 settlement を待つため、最も遅い送信が次 batch を待たせる。lease を維持して所有権を放棄せず、固定週次規模から負荷が変われば再評価する。
- SQL deadline は SQL / lock ごとの制御であり、完全な network partition や event loop 停止を取り消さない。外部サービスの実 SLA・災害復旧・権限設定はローカル test だけでは証明しない。
- 大量 backlog は複数回の保守へ分散する。保持 identity は削除しないため、長期の storage capacity は実運用の観測対象とする。

## 5. 外部仕様の根拠と gate

ライブラリの公開 API は Context7 で確認し、必要箇所を公式本文で補った。対象版は manifest / lockfile を正とする。

- Node.js 24 の [HTTP](https://nodejs.org/docs/latest-v24.x/api/http.html)・[Web Streams](https://nodejs.org/docs/latest-v24.x/api/webstreams.html)：socket・body・停止の所有。
- discord.js 14 の [mentions](https://discord.js.org/docs/packages/discord.js/14.27.0/MessageMentionOptions%3AInterface) と [Discord Message API](https://docs.discord.com/developers/resources/message)：mention 制御、本文上限、nonce の短期性。
- [Postgres.js transactions](https://github.com/porsager/postgres#transactions)、[Drizzle transactions](https://orm.drizzle.team/docs/transactions)、PostgreSQL の [期限](https://www.postgresql.org/docs/18/runtime-config-client.html)・[WITH](https://www.postgresql.org/docs/18/queries-with.html)：rollback、transaction-local 設定、集合更新。
- [Docker Node.js guide](https://docs.docker.com/guides/nodejs/)：build と本番依存・runtime の分離、非 root 実行。
- [Fly.io VM size](https://fly.io/docs/launch/scale-machine/)：`fly.toml` の memory 指定と deploy 時の設定優先順位。

実行する gate は [テスト規約 §8](./test-rule.md#8-quality-gate) に集約する。unit の件数や coverage だけで DB 競合・資源上限・コンテナの実行条件を代替しない。依存監査は照会時点の既知情報であり、未知の脆弱性の不存在を保証しない。
