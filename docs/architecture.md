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
| `src/scheduler/` | clock / DB に基づく起動時刻と配送の所有 |
| `src/runtime/` | Promise / Effect の実行・settlement、process lifecycle |
| `src/notifications/` | A/B の HTTP 認証・入力制限・運用 CLI・receiver lifecycle |
| `scripts/dev/`、`scripts/verify/` | local tool と決定論的な検証。production runtime は `src/` に置く |

feature 間では pure な型・builder・constant を参照できる。副作用を横断させるときは orchestration に置き、feature から orchestration へ逆依存させない。所有者が分かるものを汎用 `utils` / `types` に隠さない。

A/B の本文は `features/result-notifications`、配送は `scheduler/resultNotifications*` が所有する。route と slash command definition の構成は [Discord 規約 §3](./discord-rule.md#3-route-と-definition)、standalone 同期の process 境界は [同 §7](./discord-rule.md#7-slash-command-同期) を使う。

## 3. Composition root

[AppContext](../src/appContext.ts) が production の依存注入入口で、`ports` と `clock` を渡す。handler / scheduler / orchestration から real repository、DB client、system clock を直接取得しない。

- production は `makeRealPorts`、test は `createTestAppContext` で同じ interface を満たす。port 変更時は real / fake を同時に整合させる。
- port は業務単位の入出力を公開し、SQL・join・lock の知識を実装内に閉じる。各 port の責務は [DB 規約 §3](./db-rule.md#3-port-と書込の所有者)。
- Discord SDK は豊かな object model のまま境界で扱い、SDK 全体を独自 port に写さない。初期化順と resource の所有は factory / AppContext で見える形にする。

## 4. Domain の表現

用語・状態の意味は requirements、DB row 型は schema inference に合わせる。判断結果は discriminated union で表し、pending・cancel・競合負けを例外にしない。

業務 command は必要な row を lock し、同じ snapshot と渡された時刻で回答・締切・状態を判定する。任意の状態遷移を外から指定する API を作らず、その操作に必要な入力と CAS 条件を公開する。

Session の `CANCELLED` は収束途中の短命な状態になり得る。一方、通知の `CANCELLED` は終端であり、A/B を復活させない。同名の状態を領域間で同じ意味とみなさない。

## 5. 非同期処理とエラー

### 結果の分類

同期 guard は `Either`、非同期 application operation は `Effect<A, AppError>`、port は Promise と domain value を返す。分類と I/O の error 変換は [src/errors](../src/errors/) が所有する。独自 Result 型で既存 API を再現せず、`AppError.code` と既存 AppError の identity を保つ。duplicate、claim loss、race-lost、no-op は型付きの結果で表す。

batch の item failure は集計して次へ進み、同期 throw と非同期 reject で扱いを変えない。既存 AppError 以外の予期しない失敗は invariant error とする。対象の取得・識別、集計、失敗報告自体が壊れた場合は phase failure として伝える。interruption を item failure に変換して続行しない。

env / config 不正、`assertNever`、成立しない起動前提は fail-fast にする。callback と fire-and-forget の最外周は失敗を必ず受け取り、裸の Promise を残さない。result dispatcher の公開境界は `Promise<void>` とし、内部で最終 DB 状態と安全な log に収束させる。送信前の DB failure は `delivery_failed`、送信後の確定失敗は `delivery_uncertain` と区別する。

### 実行と所有権

[Effect adapter](../src/runtime/effect.ts) を application の実行境界で使う。Effect v3 の安定版で非同期処理と resource lifetime を合成し、内部で Effect → Promise → Effect を往復しない。port や DI 全体は置き換えない。API の根拠は [導入 version に合う資料](./dev-rule.md#外部仕様を判断するとき) で確認し、別 major の preview と混在させない。

| 境界 | 維持する契約 |
|---|---|
| operation の生成 | I/O・clock 読取・lock 取得を始めない。`gen` / `suspend` 内で実行時の状態を使う |
| 外部 Promise | thunk を `promiseCall` に渡し、同期 throw も失敗として受け取る |
| process / callback への出口 | `runPromiseBoundary` で一度だけ実行し、終了まで owner が追跡する。元の error を保持し、`Cause.pretty` や既定 console 出力で情報を漏らさない |
| expected failure / defect | 前者は `either` / `catchAll`、後者と interruption は別の失敗として扱う |
| 中断できない I/O | `settledCall` 等で実際の完了を待つ。並列の一つが失敗しても、未完了の兄弟より先に lock や drain の所有権を解放しない |
| resource 解放 | stop / drain の失敗後も後続 finalizer を実行する。fiber を fork するなら owner と join / interrupt を定め、daemon に逃がさない |

timeout は待機の限界であり、Discord send や DB commit が取り消された証拠ではない。中断できない I/O の完了待ちは timeout 後も続き得る。write を一般的な Effect retry で繰り返さず、durable claim・nonce・CAS による回復を使う。

message 再作成は send と message ID 保存までを中断から保護する。同一 message の Effect mutex は、待機者の interruption で実行者の lock を解放しない。

出欠と A/B の delivery scope は共通の [heartbeat](../src/scheduler/claimHeartbeat.ts) を所有し、timer を止めた後に進行中の renew を待つ。render・plan 保存・begin の待機中に claim を失ったら新しい send を始めず、開始済み send は結果を CAS 保存する。DB transaction を Discord 待機へ持ち越さない。

複数 resource の stop / drain は [lifecycle](../src/runtime/lifecycle.ts) に thunk を渡す。先行 owner の同期 throw で後続 owner を省略せず、非同期の Discord destroy も await する。失敗は settlement 後に元の原因で返す。

## 6. Scheduler と lifecycle

### 起動時刻

calendar cron は ask・retention・supervisor に限定し、実行値は設定を参照する。通常の出欠処理は `SessionsPort.getSchedulerSessionHints` と `OutboxPort.getNextDispatchAt` から one-shot timer を再構築し、due work は `runEffectTickSafely` で実行する。outbox は work がある間だけ burst 配送し、idle で停止する。

due work を処理した後に DB を再読込し、新たに due になった種類と生成済み intent を同じ再計算で拾う。一回の再計算では同種 work を一度だけ実行し、未完了 reminder を即時 loop させない。同種 timer / 再計算は一つの owned Promise にまとめ、配送・確定・次時刻取得まで待つ。実行中の wake は pending として保持し、完了時に取りこぼさない。cron callback も処理全体の Promise を返し、`noOverlap` と drain の範囲を揃える。

Interaction / 集約更新 / 起動 / 再接続後は `wakeScheduler` を呼ぶ。supervisor は missed wake・claim expiry・drift の回復手段であり、通常配送の待ち時間を決める polling には使わない。

hint 取得・tick・配送後の次時刻取得が失敗したら、有限 backoff で再計算する。batch の item failure も失敗として扱い、正常完了した段階で retry 回数を戻す。上限到達後は新しい wake / supervisor が再開する。観測 metrics の失敗で claim 回収や再計算を止めず、cron の途中登録失敗では登録済み task も破棄する。

### 起動・再接続・終了

| phase | 完了・回復の境界 |
|---|---|
| startup | readiness を閉じ、期限切れ claim、dead-letter chain、取り残された遷移、欠落 intent / message、期限超過を DB から回復する。各 phase 後に shutdown を確認する |
| ready 判定 | startup phase 完了と接続中を別に判定する。回復中の切断を見落とさず、ready と理由を log する。未 ready の Interaction は ephemeral で拒否する |
| reconnect | `shardReady` / `shardResume` の接続世代を追跡する。開始前に in-flight lock を取り、成功完了から debounce する。失敗は次の再接続で再試行し、回復中の新世代要求を保持する。同期 / Effect の失敗でも lock を解放する |
| shutdown | 新規受付と readiness を止め、startup・Interaction・reconnect・scheduler・outbox・A/B の処理中 work を上限付きで drain してから DB / Discord を閉じる。片方の失敗で他方の実 I/O の追跡を捨てない |

active message の存在 probe と出欠の FAILED chain 再投入は startup だけで行う。reconnect / tick に poison retry を持ち込まない。通常 edit の `UnknownMessage` は [Discord 規約 §5](./discord-rule.md#5-永続化後の表示更新) で回復する。shutdown と競合した HTTP listen は完了を待って close する。残った claim は次回起動で回復する。

### A/B の独立した受付と配送

receiver は DB commit 後にだけ 2xx と wake を返す。request deadline で実行中 command の slot を先に解放せず、commit 後の切断を受付失敗に戻さない。初回 startup 完了前は 503、その後の一時的な Discord 切断中は DB 受付を続ける。

dispatcher は出欠とは独立した上限付き slot と、実行中 payload の byte 予算を持つ。DB で本文サイズを確認してから claim し、予算待ちは配送完了で wake する。予算超過の既受理通知だけは単独配送を許す。完了 wake と次 retry / claim expiry の one-shot で起動し、実行中・idle 移行中の wake を保持する。DB failure の backoff は有限回とし、claim と必要な次時刻取得がともに成功したときに reset する。停止後も新しい wake / supervisor で再開できる。

連続 wake は予約済みの最早起動時刻を後ろへ動かさない。受付が続くことを理由に配送を無期限延期しない。HTTP 接続数・受付中 command 数・header と本文の期限・本文 byte 数はそれぞれ制限し、断片数に比例する buffer 配列を保持しない。未認証の未完了 header は stop 時に即回収し、受付済み DB command の所有とは分ける。

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

A/B は受付 token、別の ops token、Web Origin の三つを揃えたときだけ有効にする。部分指定と同一 token を拒否する。運用は [A/B runbook](./operations/result-notifications.md)。

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
