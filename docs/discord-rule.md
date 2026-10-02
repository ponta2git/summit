# Discord Rule

Interaction の受理、表示更新、通知 payload、slash command 同期の契約を定める。ボタンの業務上の意味は [requirements](../requirements/base.md)、transaction / outbox は [DB 規約](./db-rule.md)。route 変更は §1〜4、表示は §5〜6、登録 CLI は §7 を読む。

## 1. Ack と実行順

readiness は入口で判定し、ack の完了を待ってから入力検証・業務処理へ進む。ack を呼んだだけで DB / API 処理を並行開始しない。

| 入力 | 順序 |
|---|---|
| Component | `deferUpdate` → 未 ready なら ephemeral で終了 → guild / channel / member → route 解決 → custom ID parse → DB の Session / actor 検証 → 集約 command → commit 後の再描画 |
| Slash command | 未 ready なら即時 ephemeral `reply`。受理時は route の `deferReply` / `reply` → guard → option の narrow → application operation → `editReply` |

startup / reconnect replay 中は処理を開始せず、ephemeral で再試行を案内する。Component は未 ready の拒否時も先に defer する。押下元の文面・custom ID・表示状態を最新の DB 状態として信用しない。

dispatcher は通常処理と飽和時の拒否応答を別の有限枠で所有する。通常枠が満杯なら ephemeral で再試行を案内し、拒否枠も満杯なら追加 I/O を開始しない。両経路の Promise を開始前に追跡し、完了まで枠を保持して stop / drain に含める。上限は [config](../src/config.ts)、回帰は [admission test](../tests/discord/interactionAdmission.test.ts) を参照する。

## 2. Guard と拒否

cheap-first の順序を `configured guild → configured channel → fixed member → typed payload → persisted Session / status` に揃える。入口の検証前に DB read や状態変更をしない。user ID は Discord が認証した actor として使い、payload 内の Session / choice に権限を委ねない。

wrong guild / channel / member、malformed input、stale button、unknown command、期限切れは副作用なしの通常の拒否として ephemeral で返す。process error にしない。log は診断に必要な識別子に絞り、raw Interaction 全体を記録しない。

実装入口は [dispatcher](../src/discord/shared/dispatcher.ts) と [guards](../src/discord/shared/guards.ts)。ack 失敗時に業務処理を始めないことも境界に含める。

## 3. Route と definition

route の正本は feature ごとの `module.ts` と [registry aggregator](../src/discord/registry/modules.ts)。新 feature は module を一度登録し、dispatcher に feature 名の条件分岐を足さない。

- button prefix は `:` で終え、重複・包含を禁止する。command name も registry 全体で一意にする。不整合は起動時の registry 構築で fail-fast にする。
- route 種別ごとに handler signature を揃え、依存は `InteractionHandlerDeps` から渡す。新しい Interaction 種別は既存 route へ無理に押し込まず、その境界を設計する。
- slash definition は handler を import しない feature-local module に置き、runtime と [同期用 definitions](../src/commands/definitions.ts) が同じ値を参照する。payload の手書き複製、handler の遅延 import、Bot 初期化による定義取得をしない。
- definition の一覧一致と、同期 import graph に DB / scheduler / Bot runtime が入らないことを [definition test](../tests/discord/commands/definitions.test.ts) で守る。

## 4. Custom ID

wire format は [共通 codec](../src/discord/shared/customId.ts) に集約し、handler ごとの split / regex を作らない。業務処理へは parse 済み discriminated union だけを渡す。slot の意味は [slot](../src/slot.ts)、wire 上の choice 対応は codec が所有する。

`/cancel_week` の `cancel_week:<weekKey>:<nonce>:<choice>` は dialog 作成時の週を固定する。confirm 時は同じ clock snapshot で現在週と照合し、週跨ぎと週を持たない旧 dialog は副作用なしで再実行を促す。nonce は invocation を区別し、再押下の冪等性は週単位の DB command が守る。

format を変える場合は、投稿済みの stale button、後方互換、拒否文言も同時に扱う。現在は private guild・固定 4 人で actor 認証と DB / CAS 検証を使い、HMAC は採用しない。外部 guild、信頼できない member、custom ID だけで権限が決まる操作を導入するときに versioning・HMAC・secret rotation を一体で再評価する。

## 5. 永続化後の表示更新

Interaction は `SessionCommandsPort` の集約 command を使い、Response write と状態遷移を別 call で構成しない。DB が同時押下・遅延 snowflake・deadline との競合を解決し、Discord API は commit 後に呼ぶ。

commit 後の scheduler wake と必要な永続処理を公開 edit より先に行う。再描画の失敗は [bestEffortMessageUpdate](../src/discord/shared/messageUpdates.ts) に集約し、確定した業務操作を失敗へ戻さない。開始済み edit は settlement まで所有するが、意図した新規通知の wake をその完了待ちに置かない。

公開メッセージは最新 Session + Response から render する。同じ message の再読込・edit・削除復旧を editor で直列化し、古い描画の後着を防ぐ。別 Session は並列に進め、押下元 ID が保存 ID と一致する場合は余分な fetch を省く。

| 結果 | 回復 |
|---|---|
| DB 未 commit | operation error として返す |
| commit 後の edit failure | DB を維持し、次の Interaction / reconciler / startup で再同期 |
| `UnknownMessage` | 通常更新と startup probe が同じ editor で再投稿し、保存 ID を置換 |
| startup probe で存在確認 | 正常な message は edit しない |
| 初回投稿 | outbox が null 条件の CAS で canonical ID を確定 |

必須の新規投稿は typed outbox intent、既存 message の edit は best-effort とする。send と ID 保存の中断・lock 所有は [Architecture §5](./architecture.md#5-非同期処理とエラー)、重複を許容する配送契約は [DB 規約 §5](./db-rule.md#5-出欠-outbox)。

## 6. 表示と通知 payload

### 出欠

文言は feature-local `messages.ts`、button label は feature-local constants に置く。短く自然で非難しない日本語を使い、業務語彙の「お流れ」を維持する。

| 操作・通知 | Feedback |
|---|---|
| 通常の時刻回答、順延 OK | 公開メッセージの回答状況更新。成功 ephemeral を重ねない |
| 欠席、順延不可、週取消 | 誤押下防止の ephemeral confirmation |
| 権限外、stale、期限切れ、内部失敗 | ephemeral の拒否・失敗案内 |
| 金曜中止後 | 次の行動を求める順延確認で mention し、単なる中止通知と二重に呼び出さない |
| 土曜中止、開催決定、開始前 reminder | 次 action の有無だけで除外せず、見落とし防止の対象 mention を維持 |

mention 対象の業務仕様は requirements に従う。`dev.suppressMentions` は開発時だけ plain text にし、user config の表示名と member identity を保つ。個別成功通知を求める継続的な feedback、member / channel 増加による通知過多があれば方針を再評価する。

client の既定値は mention を禁止し、必要な投稿だけ [固定 member の許可リスト](../src/discord/shared/mentions.ts) を付ける。表示名に含まれる everyone / role / 設定外 user mention を発火させず、edit にも同じ方針を適用する。`/status` は本文上限を守り、過去の診断行は省略件数を示して短縮する。現在週・次回予定・警告合計を保つ。

### OCR・分析

`result-notifications` renderer は保存済み snapshot を描画する。業務内容は [requirements §11](../requirements/base.md)、固定 plan の保存と互換性は [DB 規約 §6](./db-rule.md#6-ocr分析通知の保存と取消)。

- 本文を上限内の連番 part へ分割し、メモ全文と Unicode 文字を欠落させない。Markdown を escape し、allowedMentions を空にして link embed を抑止する。
- 名称・メモ・順位を含む本文の escape と分割を上限付きの断片ごとに行い、全投稿の文字列配列を保持しない。part 数の計数と逐次生成で同じ分割を使い、断片境界でも既存の表示結果・nonce・renderer version を保つ。
- 新規受付は実際の origin と escape 後の本文で投稿数を検査し、超過した分析通知は一部だけ保存せず拒否する。OCR は一投稿を維持する。既受理通知には新規上限を遡及しない。上限値は [notification config](../src/notifications/config.ts)、旧出力との一致は [renderer test](../tests/features/result-notifications/render.test.ts) を参照する。
- 平均順位・対象数は前 → 後で示し、差分は丸め前の符号を保つ。初回・対象なし・比較不能・結果再利用を区別し、link は「最新の分析」と明記する。
- nonce は通知 ID + part 番号から安定生成して `enforceNonce` を使い、既送達 part は再送しない。Discord の短期重複抑止に exactly-once を依存しない。
- 保持中の通知に必要な renderer version を残し、retry 時に最新内容の新通知へ差し替えない。
- 編集しない結果投稿は、SDK の send 成功後にその message だけ cache から除き、message ID を返す。呼出側が timeout しても遅延成功時の除去を行い、cache 清掃失敗を再送の原因にしない。出欠投稿を含む SDK 全体の cache 設定は変えない。満杯時は SDK の追加処理が先に最古 entry を削除するため、既存 entry の完全な保持は保証しない。

## 7. Slash command 同期

### 操作と成功条件

guild-scoped bulk overwrite だけを使い、definition 変更時に同期する。開発は `pnpm commands:sync`、本番は運用 PC の `pnpm commands:sync:production`。実行入力と副作用は [開発規約 §2](./dev-rule.md#2-主要command)、本番手順は [同期 SOP](./operations/README.md#本番discordコマンド同期) を使う。

1. GET で definition 全体を比較する。[compare](../src/commands/sync.compare.ts) で ID / version、既定値、localization を正規化し、guild に無効な global 専用 field を除く。
2. 比較前に command / option / choice の必須構造と設定型を検証する。不正な応答を「差分」として PUT しない。Discord の全 schema を再実装する境界ではない。
3. 一致時は書き込まない。`--check` は差分があっても GET だけで終了し、差分を終了状態で示す。
4. apply は差分がある場合に一度だけ PUT し、その後の GET 一致までを成功とする。
5. PUT 到達後の通信切断・timeout・確認失敗、親が worker 完了を確認できない apply は結果不明として扱う。自動 PUT retry をせず、`--check` で現状を確認してから次を判断する。

rate limit は安全な待ち時間情報を報告して終了する。Bot 起動・Fly deploy hook・GitHub Actions に同期を組み込まず、Fly 内の実行を拒否する。同期のために Machine を増強しない。手動同期の頻度・担当者が増えた場合に、専用 workflow と secret 管理を再評価する。

### Standalone process の所有

| 所有者 | 終了まで守る境界 |
|---|---|
| supervisor | worker 一つを所有し、SDK import 前から deadline を計測する。SIGINT / SIGTERM は abort → 猶予 → 自分の子だけ kill。exit と IPC disconnect を待ち、timer / listener を回収 |
| worker | Fly と親の存在を SDK 初期化前に検証し、親を失ったら終了する。Client login、DB、scheduler を起動しない |
| 設定入口 | 必要な credential と制御値だけを worker に渡す。shell、任意の Node option、Bot 全体の環境を透過転送しない |
| REST adapter | response body を読み切ってから SDK に返す。JSON parse 前に実 byte 上限を検証し、stream / listener を回収。header 到着だけで deadline 管理を終えない |
| SDK | 自動 retry と cache sweeper を無効にする。rate limit を待ち続けず、結果通知後は SDK timer が残っても worker を終了 |
| IPC / log | typed `SyncReport` を検証し、矛盾する成功・失敗を拒否する。precheck / write / verification を区別し、raw child stdout / stderr / error を転載しない |

成功には正当な report と worker の正常終了が両方必要。CLI の body 制限は Discord の一般的な上限とは別物で、definition 増加時に再評価する。期限・終了コードは [protocol](../src/commands/sync.protocol.ts)、実装と回帰例は [supervisor](../src/commands/sync.supervisor.ts)・[同期テスト](../tests/discord/commands/)。

### Discord の権限

OAuth2 scope と Bot Permission は [README](../README.md) の最小集合、Gateway Intent は [client](../src/discord/client.ts) の `Guilds` を基準とする。追加が必要なら機能の理由と攻撃面を設計文書・PR に記す。

## 8. Error 応答と検証

route 最外周で安全な error log と generic ephemeral 応答を行う。未 ack は `reply`、replied / deferred は `followUp` を使い、`deferUpdate` 済みでも内部失敗の通知を省略しない。失敗通知自体の failure も受け取り、unhandled rejection にしない。

Discord failure と DB failure の回復は §5 の commit 境界で判断する。rate limit の log は route template / retryAfter に絞り、秘匿境界は [Architecture §7](./architecture.md#7-設定と観測) に従う。

変更が影響する ack・拒否・codec・payload・同期 process の契約を [テスト規約 §6](./test-rule.md#6-変更種別ごとの必須テスト) で選び、[§8 の gate](./test-rule.md#8-quality-gate) を通す。
