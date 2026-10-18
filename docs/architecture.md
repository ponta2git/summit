# Architecture

Summit の runtime、依存方向、非同期処理の所有者を定める。変更する境界の章から読む。業務挙動は [requirements](../requirements/base.md)、永続化は [DB 規約](./db-rule.md)、Interaction と command 同期は [Discord 規約](./discord-rule.md) が正本。

## 1. Runtime と状態の正本

Node.js / TypeScript / ESM の Bot を、Fly の常時起動する単一 Machine・単一 process で動かす。同じ設定の Bot をローカルと本番で同時起動しない。Discord client と cron は process ごとに一度だけ登録し、水平増設・scale-to-zero・外部の一時 cron は現在の構成に持ち込まない。

状態の正本は DB。Discord message、timer、process 内の lock / cache は再構築できる派生状態とする。起動・再接続・再実行で同じ DB 状態へ収束させる。単一 instance は固定 4 人向けの運用を簡単にする前提であり、unique、CAS、claim fencing を省略する根拠にはならない。

OCR・分析通知（A/B）の private HTTP receiver と dispatcher も同じ process が所有する。private bind は設定時と listen 時に検証し、public service や別 Machine を追加しない。topology を変える場合の再評価は §8、実際の変更手順は [運用入口](./operations/README.md)。

## 2. Module の所有範囲

| 配置 | 所有する責務・依存の境界 |
|---|---|
| `src/features/<feature>/` | handler、render、messages、view model、feature 固有の pure な値。小さいという理由だけで共通化しない |
| `src/discord/shared/` | dispatch、guard、custom ID codec、共通 DTO、Discord SDK の薄い adapter |
| `src/orchestration/` | 複数 feature をまたぐ send・settle・messageEditor 等の副作用の順序 |
| `src/domain/` | ASKING / POSTPONE_VOTING 等の pure な集約判断。I/O と global clock を持たない |
| `src/db/`、`src/time/`、`src/members/` | DB consumer、時刻計算、member identity の横断契約 |
| `src/scheduler/` | clock / DB に基づく業務処理の起動時刻、復旧、supervisor |
| `src/runtime/` | Promise / Effect の実行・settlement、process lifecycle |
| `src/notifications/` | A/B の HTTP 認証・入力制限・運用 CLI・receiver lifecycle、配送 runtime の組立て |
| `src/notifications/delivery/` | 出欠と A/B の配送 runtime、容量、取得方針、配送方式、通知定義とその組立て |
| `scripts/dev/`、`scripts/verify/` | local tool と決定論的な検証。production runtime は `src/` に置く |

feature 間では pure な型・builder・constant を参照できる。副作用を横断させるときは orchestration に置き、feature から orchestration へ逆依存させない。所有者が分かるものを汎用 `utils` / `types` に隠さない。

出欠と A/B の配送は `notifications/delivery`、本文は各 feature が所有する。容量管理は通知種類を参照せず、既存 config の上限を枠へ割り当てるのは `lanes.ts`、claim・次回時刻・公平性は `sources`、単発／再開可能な連番の手順は `strategies`、本文準備・業務確定は `definitions` に置く。容量枠・通知種類・配送方式は独立して扱う。OCR の独立枠への再配置には、claim・次回時刻・譲渡の DB 条件も揃える必要があり、設定変更だけで可能とは扱わない。

変更範囲の確認には次の契約を使う。構造上の分離を示すもので、保守工数や障害件数の削減を計測した結果ではない。

| 変更 | 所有する場所と根拠 |
|---|---|
| 件数・byte 上限 | [出欠 config](../src/config.ts) / [結果通知 config](../src/notifications/config.ts) が正本。`lanes.ts` と DB の既定値・譲渡条件も同じ定数を参照する。[容量契約](../tests/notifications/delivery.capacity.test.ts)は通知種類なしで検証する |
| 既存方式の本文・業務確定 | definition の登録表と feature の renderer。出欠は描画と固有の業務確定を同じ定義へ登録する。[追加定義の配送](../tests/notifications/attendance.definitions.test.ts)で共通 backfill・配送確定まで検証する |
| 結果通知の描画 version | [renderer 登録表](../src/features/result-notifications/render.ts)が正本。受付時の投稿数検査と配送時の定義が同じ renderer を参照する。新規受付上限と保存済み通知の上限は分ける |
| Delivery / Strategy の差替え | `composition.attendance.ts` / `composition.result.ts` が手動 DI で組み立てる。[runtime 注入](../tests/notifications/delivery.runtimeInjection.test.ts)と[結果の実配送](../tests/notifications/delivery.resultComposition.test.ts)で容量・終了待ち・保存まで検証する |
| 連番の再開・譲渡手順 | [連番 Strategy](../src/notifications/delivery/strategies/resumable.ts)が所有。[再開契約](../tests/notifications/resumable.test.ts)は通知種類なしで順序と確定後の譲渡を検証する |
| 結果通知の失敗分類 | 配送の外部 I/O adapter と同期準備の入力検証。Strategy・容量管理へ通知種類や retry の分岐を追加しない。[配送テスト](../tests/scheduler/resultNotifications.delivery.test.ts)と[準備テスト](../tests/notifications/resultDefinition.test.ts)で通常失敗と defect を区別する |

HTTP の受付枠・本文予約・DB work の drain は [http.ts](../src/notifications/http.ts)、socket の header 待ち・再利用・pipeline の応答追跡は [http.connections.ts](../src/notifications/http.connections.ts) に集約する。未受付の接続を回収しても、受付済み DB work の所有を失わない境界とする。route と slash command definition の構成は [Discord 規約 §3](./discord-rule.md#3-route-と-definition)、standalone 同期の process 境界は [同 §7](./discord-rule.md#7-slash-command-同期) を使う。

## 3. Composition root

[AppContext](../src/appContext.ts) が production の依存注入入口で、`ports` と `clock` を渡す。handler / scheduler / orchestration から real repository、DB client、system clock を直接取得しない。

- production は `makeRealPorts`、test は `createTestAppContext` で同じ interface を満たす。port 変更時は real / fake を同時に整合させる。
- port は業務単位の入出力を公開し、SQL・join・lock の知識を実装内に閉じる。各 port の責務は [DB 規約 §3](./db-rule.md#3-port-と書込の所有者)。
- Discord SDK は豊かな object model のまま境界で扱い、SDK 全体を独自 port に写さない。初期化順と resource の所有は factory / AppContext で見える形にする。

配送の具体実装は [出欠の組立て](../src/notifications/delivery/composition.attendance.ts) / [結果の組立て](../src/notifications/delivery/composition.result.ts) が接続する。runtime は具体的な Delivery・renderer・Strategy を import せず、取得済み通知を [DeliveryTask](../src/notifications/delivery/contracts.ts) にする関数を受け取る。Task は通知 ID・予約 byte 数・実行関数だけを持ち、実行関数へ渡す停止確認を尊重する。容量の予約・解放は runtime が所有する。出欠の timer は注入した batch と次回時刻取得を起動し、batch は Task の全件終了を待つ。

定義の登録表は保存契約に合わせて出欠 / 結果を分ける。出欠の共通 message ID 保存と claim 付き配送確定は定義の組立てに残し、通知固有の業務確定だけを登録する。結果は renderer version・宛先・partCount の保存済み契約を確認してから再開する。Strategy は方式別の公開入力型・関数型で注入し、単発と連番を optional field の多い共通型へ統一しない。現在の出欠は単発、OCR・分析は連番であり、1投稿という理由で方式を切り替えない。

Task の生成は非同期 I/O を開始しない。出欠の DB 読取・描画は heartbeat 管理下の遅延 Effect、結果の検証・plan 準備は同期のままにする。factory の同期 throw や claim と異なる ID・byte 予約は、元の予約情報を持つ個別 defect として終了を追跡し、後続通知を止めたり通常の retry に変換したりしない。出欠の byte 会計は従来どおり0で件数を制限する。停止後に claim が返った場合は新規 Task を起動せず、未開始 claim は期限切れ回復へ残す。

同じ配送契約の本文追加は定義・描画・必要な受付契約で扱い、runtime・容量・既存 Strategy に通知種類の分岐を追加しない。新しい結果 kind の受付には共有 schema と validation、取得の優先・譲渡条件も整合させる。異なる保存・確定手順には対応する Delivery / Strategy が必要であり、DI だけで任意に互換になるとは扱わない。動的 plugin、DI container、汎用 Source への統一は現在の拡張点に必要ない。

## 4. Domain の表現

用語・状態の意味は requirements、DB row 型は schema inference に合わせる。判断結果は discriminated union で表し、pending・cancel・競合負けを例外にしない。

業務 command は必要な row を lock し、同じ snapshot と渡された時刻で回答・締切・状態を判定する。任意の状態遷移を外から指定する API を作らず、その操作に必要な入力と CAS 条件を公開する。

Session の `CANCELLED` は収束途中の短命な状態になり得る。一方、通知の `CANCELLED` は終端であり、A/B を復活させない。同名の状態を領域間で同じ意味とみなさない。

## 5. 非同期処理とエラー

### 結果の分類

同期 guard は Effect の `Result`、非同期 application operation は `Effect<A, AppError>`、port は Promise と domain value を返す。分類と I/O の error 変換は [src/errors](../src/errors/) が所有する。独自 Result 型で既存 API を再現せず、`AppError.code` と既存 AppError の identity を保つ。duplicate、claim loss、race-lost、no-op は型付きの結果で表す。`Result` を非同期処理へ取り込むときは、実行中の generator 内で `Effect.fromResult` を使う。

batch の item failure は集計して次へ進み、同期 throw と非同期 reject で扱いを変えない。既存 AppError 以外の予期しない失敗は invariant error とする。対象の取得・識別、集計、失敗報告自体が壊れた場合は phase failure として伝える。interruption を item failure に変換して続行しない。

出欠 outbox は明示した上限で並列配送し、全配送の settlement 後に入力順で最初の確定失敗を返す。render から配送までを同じ Effect の Context と中断管理下で合成し、defect / interruption を通常の retry 記録へ変換しない。

env / config 不正、`assertNever`、成立しない起動前提は fail-fast にする。callback と fire-and-forget の最外周は失敗を必ず受け取り、裸の Promise を残さない。配送 runtime の公開境界は `wake / stop / drain` とし、drain は `Promise<void>` で所有処理の終了を待つ。配送内の typed failure は durable retry と安全な log に収束させ、defect / interruption は通常の retry に変換せず owner へ返す。送信前の DB failure は `delivery_failed`、送信後の確定失敗は `delivery_uncertain` と区別する。

### 実行と所有権

[Effect adapter](../src/runtime/effect.ts) を application の実行境界で使う。Effect v4 の安定版で非同期処理と resource lifetime を合成し、内部で Effect → Promise → Effect を往復しない。port や DI 全体は置き換えない。API の根拠は [導入 version に合う資料](./dev-rule.md#外部仕様を判断するとき) で確認し、別 major の preview と混在させない。

| 境界 | 維持する契約 |
|---|---|
| operation の生成 | I/O・clock 読取・lock 取得を始めない。再利用する generator 関数は `fnUntraced`、局所的な合成は `gen` / `suspend` を使い、実行時の状態を読む |
| 外部 Promise | thunk を `promiseCall` に渡し、同期 throw も失敗として受け取る |
| process / callback への出口 | `runPromiseBoundary` または `runPromiseResultBoundary` で一度だけ実行し、終了まで owner が追跡する。単一 error の identity を保持し、`Cause.pretty` や既定 console 出力で情報を漏らさない |
| expected failure / defect | `runPromiseResultBoundary` / `catchExpectedError` は Cause 全体を分類してから typed failure だけを回復する。defect / interruption が混在する Cause を `result` / `catch` / `squash` だけで正常結果に変換しない |
| 中断できない I/O | `settledCall` 等で実際の完了を待つ。並列の一つが失敗しても、未完了の兄弟より先に lock や drain の所有権を解放しない |
| resource 解放 | stop / drain の失敗後も後続 finalizer を実行する。fiber を fork するなら owner と join / interrupt を定め、daemon に逃がさない |

timeout は待機の限界であり、Discord send や DB commit が取り消された証拠ではない。中断できない I/O の完了待ちは timeout 後も続き得る。write を一般的な Effect retry で繰り返さず、durable claim・nonce・CAS による回復を使う。

message 再作成は channel 取得後の send と message ID 保存までを中断から保護する。取得待機中の interruption 後に新しい send を始めない。同一 message の Effect mutex は、待機者の interruption で実行者の lock を解放しない。

出欠と A/B の delivery scope は共通の [heartbeat](../src/notifications/delivery/claimHeartbeat.ts) を所有し、timer を止めた後に進行中の renew を待つ。claim loss は通知 callback より先に記録し、heartbeat 自体の予期しない失敗も配送の settlement 後に owner へ返す。render・plan 保存・begin の待機中に claim を失ったら新しい send を始めず、開始済み send は結果を CAS 保存する。DB transaction を Discord 待機へ持ち越さない。

複数 resource の stop / drain は [lifecycle](../src/runtime/lifecycle.ts) に thunk を渡す。先行 owner の同期 throw で後続 owner を省略せず、非同期の Discord destroy も await する。失敗は settlement 後に元の原因で返す。

## 6. Scheduler と lifecycle

### 起動時刻

calendar cron は ask・retention・supervisor に限定し、実行値は設定を参照する。通常の出欠処理は `SessionsPort.getSchedulerSessionHints` と `OutboxPort.getNextDispatchAt` から one-shot timer を再構築し、due work は `runEffectTickSafely` で実行する。出欠配送 runtime は work がある間だけ burst 配送し、idle で停止する。scheduler は共有した次回時刻を出欠 runtime に渡し、配送 timer・batch・stop / drain の所有は [attendanceRuntime](../src/notifications/delivery/attendanceRuntime.ts) に置く。

due work を処理した後に DB を再読込し、新たに due になった種類と生成済み intent を同じ再計算で拾う。一回の再計算では同種 work を一度だけ実行し、未完了 reminder を即時 loop させない。同種 timer / 再計算は一つの owned Promise にまとめ、配送・確定・次時刻取得まで待つ。実行中の wake は pending として保持し、完了時に取りこぼさない。cron callback も処理全体の Promise を返し、`noOverlap` と drain の範囲を揃える。

Interaction / 集約更新 / 起動 / 再接続後は `wakeScheduler` を呼ぶ。supervisor は missed wake・claim expiry・drift の回復手段であり、通常配送の待ち時間を決める polling には使わない。

hint 取得・tick・配送後の次時刻取得が失敗したら、有限 backoff で再計算する。batch の item failure も失敗として扱い、正常完了した段階で retry 回数を戻す。上限到達後は新しい wake / supervisor が再開する。観測 metrics の失敗で claim 回収や再計算を止めず、cron の途中登録失敗では登録済み task も破棄する。

### 起動・再接続・終了

| phase | 完了・回復の境界 |
|---|---|
| startup | readiness を閉じ、期限切れ claim、dead-letter chain、取り残された遷移、欠落 intent / message、期限超過を DB から回復する。各 phase 後に shutdown と maintenance admission を確認する |
| ready 判定 | startup phase 完了と接続中を別に判定する。回復中の切断を見落とさず、ready と理由を log する。未 ready の Interaction は ephemeral で拒否する |
| reconnect | `shardReady` / `shardResume` の接続世代を追跡する。開始前に in-flight lock を取り、成功完了から debounce する。失敗は次の再接続で再試行し、回復中の新世代要求を保持する。同期 / Effect の失敗でも lock を解放する |
| shutdown | 新規受付と readiness を止め、startup・Interaction・reconnect・scheduler・outbox・A/B の処理中 work を上限付きで drain してから DB / Discord を閉じる。片方の失敗で他方の実 I/O の追跡を捨てない。timeout / cleanup failure は成功と区別して exit 1 を返す |

active message の存在 probe と出欠の FAILED chain 再投入は startup だけで行う。reconnect / tick に poison retry を持ち込まない。通常 edit の `UnknownMessage` は [Discord 規約 §5](./discord-rule.md#5-永続化後の表示更新) で回復する。shutdown と競合した HTTP listen は完了を待って close する。残った claim は次回起動で回復する。

### 稼働中の移行 drain

[maintenance controller](../src/startup/maintenanceDrain.ts) は通常 process 内の受付状態を readiness と独立して所有する。`admission` は新しい Interaction・reconnect・scheduler を止め、startup の次 phase を開始せず、通知設定 / retry を拒否する。受理済みの操作は実 I/O が settle するまで待つ。この段階では上流 producer からの receipt と結果通知配送を続ける。`all` はその receipt と dispatcher の新規 claim も止め、開始済みの受付・配送・確定を drain する。どちらの段階も通知設定の enabled / generation を変更しない。

[運用 HTTP](../src/startup/maintenanceHttp.ts) は単一の operations token を要求し、通常の業務 readiness や command slot とは独立した枠で受付 / 状態取得を行う。POST の 202 は停止要求の受付であり、完了は GET の同じ cutoverId / stopEpoch / stage と writer 状態で確認する。control request は自身が待つ business drain の集合に入れず、listener を残して完了を観測できるようにする。本文512 byte・control同時2件・既存の本文 / 接続期限で制限する。

同一 process では同一 cutover の段階前進だけを許し、他 cutover・異なる epoch・段階後退を拒否する。duplicate は処理を再起動せず現在値を返す。writer ごとの期限は通常 shutdown と同じで、期限後も実 I/O を追跡するが `timed_out` を遅延完了で `drained` に戻さない。stop / drain の失敗は固定分類で示し、他 writer の所有を維持する。`drained` は選択した process 内 writer の settlement であり、DB に未終端 work がないことや外部 writer の停止を意味しない。

### 移行中の凍結起動

`MOMO_MAINTENANCE_MODE` は未指定 / `normal` を通常起動、`frozen` を業務処理の凍結として起動時に検証する。未知値は失敗し、稼働中の mode 切替は行わない。[index](../src/index.ts) が通常 bootstrap の import より前に分岐するため、frozen は AppContext・通常 DB pool・Discord client・member reconcile・Interaction・reconnect・通知受付 / 配送・scheduler・startup recovery を生成も実行もしない。通知の enabled / generation と保存済み claim・payload・part は変更しない。

frozen は [専用 readiness](../src/startup/maintenanceReadiness.ts) だけを private listener へ公開する。単一の operations token による認証後、[DB probe](../src/startup/maintenanceDatabase.ts) が read-only transaction と期限付きの `LIMIT 0` で同梱 schema の主要 consumer table / column の参照可能性を確認する。readiness は固定状態と接続先の opaque fingerprint を返し、DB 行・接続値・例外本文を含めない。制約・値の互換性、migration ledger、書込み権限、外部到達性はこの probe の検証対象に含めず、移行 gate で確認する。

probe は同時に一つだけ所有し、応答期限や切断後も完了を追跡する。停止後は成功 readiness を返さず、listen の完了後に listener を閉じ、probe の settlement と DB pool の期限付き close を待つ。通常運転からは live drain の完了を確認し、永続した frozen 設定で再起動してから DB の停止点を確定する。live drain は process 内の状態なので、cutover 証跡と再起動時の frozen 維持は外部の共通 control が所有する。操作手順は [migration runbook](./operations/migration.md#凍結したままの起動と接続確認) を参照する。

### A/B の独立した受付と配送

receiver は DB commit 後にだけ 2xx と wake を返す。request deadline で実行中 command の slot を先に解放せず、commit 後の切断を受付失敗に戻さない。初回 startup 完了前は 503、その後の一時的な Discord 切断中は DB 受付を続ける。

dispatcher は出欠とは独立した上限付き slot と、実行中 payload の byte 予算を持つ。DB で本文サイズを確認してから claim し、予算待ちは配送完了で wake する。新規受付・枠補充の wake は次の timer turn で起動し、重複要求だけをまとめる。実行中・idle 移行中の wake を保持し、連続 wake で開始時刻を延期しない。出欠の debounce は変更しない。

[DeliveryCapacity](../src/notifications/delivery/capacity.ts) は予約 byte 数と完了待ちを一つの Map に登録し、実行 fiber はその Scope が所有する。別の fiber 一覧を重ねず、残り件数・byte 数を台帳から導出する。予約・実行登録・解放は runtime が所有し、配送方式へ渡す context に容量の増減権限を持たせない。登録前に fiber を開始せず、同期準備失敗でも予約を解放する。claim は直列化し、件数・byte 条件を本文取得前に source へ渡す。stop と claim 完了の競合でも取得済み work を管理下に置く。timer と起動期限も一つの状態で保持する。

出欠の [attendanceBatch](../src/notifications/delivery/attendanceBatch.ts) は最大10件の batch を全件 settlement してから次へ進み、A/B は最大2件・512 KiBの枠を空き次第補充する。容量所有の共通化でこの駆動方針を統一しない。runtime の実行範囲は pump・配送・heartbeat の終了まで追跡し、新規 claim を止めてから開始済み I/O と確定処理を drain する。

単発 Strategy は送信→開催履歴等の業務確定→message ID 保存→配送完了を維持する。連番 Strategy は配送済み part を飛ばし、begin→send→complete の後だけ譲渡を判断する。通知固有の判断は definition と source に置き、Strategy に通知種類の分岐を加えない。

次 retry / claim expiry は one-shot で起動する。DB failure の有限 backoff 中は、処理中に受けた wake や新規受付でも回復期限を早めない。claim と必要な次時刻取得がともに成功したときに reset し、有限 retry を使い切った後も新しい wake / supervisor で再開できる。

claim は OCR と分析の優先種別を交互に切り替え、一方だけなら空き slot を使う。種別内は既存の予定時刻・ID 順を保ち、残りの byte 予算に収まらない最古通知は追い越さず、実行中配送を排出してから扱う。別種別の due 通知が待つ場合、長文配送は投稿の complete 後・次の begin 前に claim を譲れる。開始済み投稿がないことを DB で確認し、失敗の試行予算を消費せず再取得する。既受理の本文・renderer・宛先・配送済み番号を再開時も使い、完了済み投稿を繰り返さない。予算超過の旧通知は単独配送を続け、途中で譲らない。譲渡のDB確認は配送開始後と外部wakeの世代が変わった時に限り、各投稿で繰り返さない。全slot使用中に未来のretryがdueになった場合は、次のwake・slot解放・supervisorで検知する。

claim は本文と再開に必要な配送済み part 番号だけを返し、監査用の part 詳細は inspect が取得する。同期の検証・描画準備後、非同期配送は検証済み plan と小さい metadata を保持し、元の claim batch / payload を完了 callback に閉じ込めない。不正 item も個別配送の settlement を通り、予約した byte 予算を必ず戻して後続 item を継続する。譲渡時も配送と heartbeat の settlement まで slot・byte 予算を保持し、plan の参照を手放してから補充する。再開用 payload をメモリに退避して予算外へ増やさない。

結果投稿の SDK cache は送信成功時にその message だけを解放し、DB 確定には message ID を渡す。送信 timeout は SDK 内の実 I/O を中止しないため、待機期限後の成功でも cache 解放を行う。dispatcher の論理 slot 上限を SDK 内の未完了 request 数の上限とは扱わない。

HTTP は本文消費済みの成功応答で接続を再利用し、拒否・例外・未読本文がある応答は切断する。接続32・受付中 command 4を維持し、各接続は100要求、idle 5秒と Node の1秒 bufferで区切る。header は接続時と全応答完了時から20秒の固定期限を置き、先行応答中の pipeline も Node の header / request 期限20秒・検査周期1秒で保護する。本文期限10秒と byte 予算は各要求に適用し、断片数に比例する buffer 配列を保持しない。stop は idle・未完了 header の接続を回収し、drain は受付済み DB command と listener の終了を待つ。

本文は受付全体の byte 予算も予約し、応答期限後も DB command の settlement まで解放しない。長さ不明なら一本文の最大量を予約する。JSON.parse 前の構造数・深さの検査と、配列検証の最初の不正での打切りにより、byte 上限内の悪性入力が大量の object / validation issue を生成する経路も抑える。新規受付の件数・文字数・正規化容量・描画後投稿数を別々に検査し、保存済み通知の再送とは validator を分ける。

supervisor は出欠処理より先に A/B を wake する。一方の family の失敗が他方の配送や retention を止めないようにし、idle 時の短周期 polling を増やさない。設定値は [notifications/config](../src/notifications/config.ts)、保存契約は [DB 規約 §6](./db-rule.md#6-ocr分析通知の保存と取消) を参照する。

## 7. 設定と観測

| 正本 | 所有する情報 |
|---|---|
| `src/userConfig.ts` と YAML | guild / channel / member、schedule、mention 方針。起動時に zod で検証 |
| `src/envSchema.ts` / `src/env.ts` | secret、DB 接続、設定本文、deploy metadata。schema は pure、env 入口で一度 parse |
| `src/config.ts`、領域別 config | retry・timeout・信頼性の内部設定 |

runtime は parse 済み export を使い、個別 module で環境変数を読み直さない。用途別 CLI は必要な入力だけの設定入口を持つ。command 同期に Bot 全体の env / DB / scheduler 初期化を持ち込まない。local file の読取条件は [開発規約 §7](./dev-rule.md#7-environment-と-secret)。

member は固定 4 人・ID 重複なしを検証する。起動時 reconcile は identity と表示名を一 transaction で整合し、設定から消えた row を削除したり、配列順で過去の ID を再利用したりしない。

A/B は通常起動で受付 token、別の ops token、Web Origin の三つを揃えたときだけ有効にする。部分指定と同一 token を拒否する。frozen は ops token を必須とし、A/B を有効にしないため残る二つの設定は必須にしない。運用は [A/B runbook](./operations/result-notifications.md)。

YAML は Bot と同期 CLI の共通 [parser](../src/userConfig.yaml.ts) で byte / alias 上限を適用し、warning を含む曖昧入力を拒否する。parser の入力断片を stderr に出さない。A/B token は Bearer 構文を検証し、HTTP は単一 Authorization だけを受理する。運用 CLI も本文読取まで deadline を維持し、実 byte 上限・UTF-8 / JSON を検証して失敗時の stream を回収する。

log は pino の JSON stdout に統一する。外部 error の message / stack / URL / body / SQL bind をそのまま渡さず、固定の診断文、code / status、上限のある cause 分類へ変換する。AppError の内部 cause 保持と log への出力は区別する。DB に保存する failure reason も同じ扱いにする。key redact は追加防御であり、未加工 payload を出力する根拠にはしない。

Discord rate limit は route template と待ち時間を記録し、token や major parameter を除く。機密 URL も秘匿対象とし、redact path を狭める変更は review する。外部 healthcheck ping は追加せず、log / status の観測を使う。

## 8. 設計を再評価する条件

| 現在採用しないもの | 現在の理由 | 再評価する変化 |
|---|---|---|
| 複数 instance、外部 cron | 固定 4 人の負荷を単一 process で扱える | 可用性・負荷・provider 能力が変わる。scheduler、leader、claim、復旧を一体で設計する |
| DI container / Effect Layer、全 port の Effect 化 | factory / AppContext と Promise ports で依存が見える | 依存 graph・resource lifetime を現在の合成で表せなくなった |
| XState | pure decision と CAS で状態遷移が閉じる | 並行・階層・履歴状態や guard が複雑になる |
| event sourcing | 現在の DB 状態で要件を満たす | replay / 履歴監査が要件になる |
| broker / 外部 queue | PostgreSQL outbox で規模と運用を満たす | throughput・順序待ち・遅延・保守が実測上の制約になる |
| OpenTelemetry 等の追加観測基盤 | 単一 process の log / status で追跡できる | service 間 trace や SLO の運用が必要になる |

実装確認の入口は [runtime](../src/runtime/)、[scheduler](../src/scheduler/)、[notifications](../src/notifications/)。変更が壊し得る境界を [テスト規約 §6](./test-rule.md#6-変更種別ごとの必須テスト) で選び、[§8 の gate](./test-rule.md#8-quality-gate) まで確認する。
