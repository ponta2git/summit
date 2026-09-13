# Database Rule

Summit が共有 PostgreSQL を利用する際の所有権、persistence boundary、transaction、race、Discord outbox、migration 契約を定める。schema の実装正本は sibling `momo-db` リポジトリにあり、Summit はconsumerである。

## 1. Schema と migration の所有権

- `../momo-db` の schema、migration、Drizzle 設定・script、または DB の migration state を変更する前に、`../momo-db/docs/development.md` を最初から最後まで読み、その手順に従う。checkout / 文書の欠落や Summit 規約との矛盾があれば停止し、Summit 側で独自の authoring 手順を補わない。
- schema、constraint、migration SQL、Drizzle設定は `../momo-db/src/schema.ts`、`../momo-db/drizzle/`、`../momo-db/drizzle.config.ts` が所有する。
- Summit の `src/db/schema.ts` は `@momo/db` のre-export shimであり、独自schemaを追加しない。
- 通常の schema migration と custom SQL migration の作り分け、履歴の不変性、data safety、検証、rollback は momo-db の正規文書だけを正本とする。
- `drizzle-kit push`は使用しない。migration履歴を飛ばすschema同期は再現性とreviewを失うためである。
- 本番migrationはdeployから独立して先行適用する。SummitのFly deployにrelease commandを追加しない。
- applicationはpooled `DATABASE_URL`、migrationだけがunpooled `DIRECT_URL`を使う。Summit runtimeに`DIRECT_URL`を導入しない。
- sibling repositoryのcheckout/buildが必要なため、local setup、Docker build、CIの相対配置を崩さない。

共有DBが不要になった場合はrepository統合を、consumerが増えた場合はversioned package distributionを再評価する。file dependencyのままconsumer数だけを増やさない。

## 2. Client とquery safety

- application DB clientは`src/env.ts`で検証済みの接続情報だけを使う。
- postgres.jsはpooler互換設定を維持する。具体optionは`src/db/client.ts`を正本とする。
- user inputを`sql.raw()`へ渡さない。動的column/orderはallowlistから選ぶ。
- SQL bind値とconnection stringをlogへ出さない。
- production DBへの手動`INSERT`、`UPDATE`、`DELETE`、`TRUNCATE`、`DROP`で状態を修復しない。reproducible migration、application recovery、documented runbookを使う。
- local resetは`scripts/dev/reset.ts`のhost guardを通る`pnpm db:reset`だけを使う。

## 3. DB を正本にする

- Session、Response、HeldEvent、delivery intentの正本はPostgreSQL。
- Discord message、in-memory timer、Promise lock、process readinessは派生状態。
- Discord API失敗でpersist済み状態を巻き戻さない。
- cron、startup、reconnectは毎回DBを読み、同じ処理を複数回実行しても同じ状態へ収束させる。
- uniqueness、allowed state、foreign key、check constraintはDBでも守り、applicationだけの事前checkに依存しない。

主要な一意性の意味:

- 同じweek/postpone段階のSessionを一件にする。
- 同じSession/memberのResponseを一件にする。
- 同じSessionから作るHeldEventを一件にする。
- 同じ意味のdelivery intentをstatusにかかわらず一件にする。
- 同じSession revision/ordinalの意味順序を一件にする。

列名、index名、enum値はmomo-dbのschemaが正本なので、本書には複製しない。

## 4. Port とwrite boundary

`src/db/ports.ts`をapplicationから見たDB契約の正本とする。

### `SessionsPort`

- read model、初回Session作成、message ID maintenance、scheduler hintを扱う。
- business transitionを公開しない。
- message ID backfillはNULLに対するCASでcanonical messageを先勝ち決定する。

### `SessionCommandsPort`

- Session aggregateのwrite boundary。
- Sessionを先にlockし、member、deadline、Response、current statusを同じsnapshotで評価する。
- Response、state transition、aggregate sequence、delivery intentを同じtransactionで確定する。
- handlerが`ResponsesPort`と`SessionsPort`のwriteを組み合わせて独自transactionを作らない。

### `HeldEventsPort`

- 実開催履歴だけを扱う。
- `DECIDED`からterminal状態へのtransitionとHeldEvent/participantsの作成を同じtransactionで行う。
- 参加者は現在のconfigではなく、そのSessionに保存された回答snapshotから決める。
- 中止・skipされたSessionからHeldEventを作らない。

### `OutboxPort`

- 共通通知 DB の attendance family に限定し、recovery用の単独enqueue、claim、送信開始、delivery確定、retry、retention、metrics、next dispatch hintを扱う。
- business transitionからのenqueueは、可能な限り`SessionCommandsPort`またはSession作成transaction内で行う。
- A/B の設定・固定 payload・取消は [momo-db の共有通知契約](../../momo-db/docs/discord-notifications.md) に従う。既存アンケートの設定・順序・起動時回復を A/B へ適用しない。

## 5. Transaction とrace

- read-modify-writeをtransaction外で行わない。
- state transitionは期待from-stateを条件にしたCASとして実行する。
- race lostはerrorではなくtyped result/no-opとして返し、最新rowを再取得して表示を収束させる。
- interaction由来ResponseはDiscord snowflakeでfenceし、遅れて届いた古いInteractionが新しい回答やaggregate revisionを上書きしない。
- 同時`/ask`とcalendar tickはprocess内in-flight最適化とDB uniqueの二段で吸収する。正しさはDB uniqueが担う。
- `/cancel_week`は対象Sessionを決定論的順序でlockし、skip、競合intent取消、通知intentを一つのtransactionで確定する。金曜lockの待機中に順延transactionが土曜を作成し得るため、金曜を保持した後の新しいstatement snapshotで週全体を再読込する。Session未作成時はsentinelで後続作成を抑止する。
- transaction中にDiscord APIを待たない。

## 6. アンケートの Discord 配送

PostgreSQLとDiscordを同一transactionにできないため、業務上必須の新規投稿はtyped delivery intentとしてDBへ保存し、at-least-onceで配送する。

保存先は共有通知本体とアンケート関連・配送部分の組合せとする。repository が attendance DTO を組み立て、アプリケーションの command として claim / 開始 / 確定 / 整理を実行する。通知の業務関数・trigger は DB に置かない。A/B は Session を作らず、別 family の契約で接続する。

### Enqueue と順序

- 初回募集、順延募集、settlement通知、順延確認、開催決定、reminder、週取消通知をtyped rendererで表現する。
- Session aggregate revisionと同一変更内ordinalで意味順序を付ける。
- workerは同じSessionの未完了またはdead-letterの先行intentを飛び越えない。
- 先行intentがdead letterになった場合、意味上の後続を取消し、誤順序の通知を防ぐ。
- dedupe keyはstatusを問わず一意とし、retryのために別rowを作らない。
- 実装済みkindだけをschema/rendererへ公開する。宣言だけで処理経路のないkindを追加しない。

### Claim とdelivery

- claimごとに所有権tokenを発行する。
- Discord 呼出し直前に beginDelivery を行う。取消・期限切れ・所有権喪失なら送らない。
- delivered/failedの確定は同じ有効tokenのownerだけが成功できる。
- claim expiry後は旧workerと新workerの両方がDiscord受理へ到達し得る。古いownerのDB確定はno-opにするが、外部投稿の重複までは排除できない。
- message ID backfillはCAS-on-NULLでcanonical messageを決める。
- Discord受理後・DB確定前のcrashでは、欠落より重複を選ぶ。
- payload/state mismatchや未対応rendererは握りつぶさずdead letterへ送る。
- retry/backoff/max attempt/claim duration/batch sizeの実値は`src/config.ts`が正本。
- claim制御・part更新・状態照会では必要な状態列だけを読む。配送本文はclaimが確定したバッチから一度取得し、取消確認のために本文を読み直さない。対象の生存確認とclaim fencingは省略しない。
- 次回配送時刻はPENDINGのretry時刻と残存claimの期限を別々に検索する。永久保持する終端履歴の全走査を避け、family・処理中IDの除外を共通の`notifications.dispatch.ts`で扱う。

### Reminder completion

- reminder schedulerはdue intentのenqueueだけを行う。
- workerがDiscord受理後、Session completionとHeldEvent作成を同じDB transactionで確定し、その後intentをdeliveredにする。
- reminder不要条件ではDiscordを介さず同じcompletion contractへ収束する。
- Discord受理とcompletionの間で停止した場合はreminderが重複し得るが、HeldEvent欠落を避ける。

### Recovery

- expired claimはreconcilerが回復し、試行上限内ならPENDING、上限到達ならFAILEDにする。
- poison payloadのFAILED chain復帰はstartupだけで行い、attemptと先行失敗に由来する後続cancelを同じtransactionでresetする。手動週取消と A/B の通知は復帰させない。
- reconnectや定期supervisorでFAILEDを無条件復帰させずhot loopを防ぐ。
- non-terminal Sessionのmessage IDがNULLなら、直接sendせず予約ordinalのrecovery intentをenqueueする。
- Discord上で既存messageが削除済みと確認できた場合のedit対象再生成はbest-effort reconcilerが担う。

外部brokerは現在採用しない。DB outboxの量、head-of-line blocking、latency、maintenance costがbroker追加コストを上回る場合に再評価する。

## 7. Retention とobservability

- active stateはpruneしない。
- terminal 通知は status 別 policy で本文・配送詳細を整理し、通知 ID / dedupe / 内容照合情報と終端状態を永久保持する。本文整理後の失敗通知を起動時に復帰させない。
- retention schedule と consumer の cutoff は `src/config.ts`、アプリ間の保持期間と整理条件は momo-db の共有通知契約を正本とする。判断・実行はアプリが所有する。
- 保持期限とconsumer cutoffの両方を満たす行だけをlockし、上限付きの一括更新で詳細を整理する。複数バッチでも一つのcommandとしてrollbackでき、IDと内容照合情報を残す。
- metricsはpending/in-flight/failedとoldest ageを構造化logへ出す。
- warn thresholdは`src/config.ts`が正本。
- `/status`はstranded Session/outbox/HeldEvent invariantをread-onlyで表示する。
- 外部healthcheck pingをoutboxやschedulerへ混在させない。

詳細な調査・復旧は`docs/operations/outbox.md`と`docs/operations/recovery.md`を参照する。

### A/Bの受付・取消・配送

`ResultNotificationsPort`は生JSON受付、設定、配送、状態照会、明示再試行、保持を所有する。real/fakeに共通の契約testを適用し、数値精度・transaction・競合は実DBで検証する。本文形式と取消・再試行判断は`src/domain/`、更新境界は`resultNotifications.*`と`notifications.*`のrepositoryに置く。

- 受付は親・固定payload・結果関連・取消対象とPENDINGまたはCANCELLEDを一つのcommandで保存する。既存IDの内容照合を新規version検証より先に行う。hashは旧JSONB数値正規化と互換にし、JSの数値丸めを使わない。
- 設定変更はON/OFF・世代・未開始部分取消を同じcommitに含める。利用者向け設定はmomo-result APIが共有DBへ直接保存し、Summitの稼働に依存しない。Summitの運用設定commandと同じresult gateを使うため、受付・送信開始・再試行はAPIがcommitした世代とOFFを観測する。対象変更はmomo-resultの業務commandの末尾で通知を取り消す。transactionの集約単位とlock順はアプリの契約であり、DBの機能に判断を任せない。
- `notificationTransaction`はREAD COMMITTEDとfamily gateを指定する。対象writerは業務行を書いてからresult gateを取得する。gate取得後は業務行のlockを取らず、Discord I/Oを行わない。全writerの取得順は[共有契約](../../momo-db/docs/discord-notifications.md#アプリケーションの更新境界)を守る。
- 初回描画でrenderer・部分数・リンクorigin・チャンネルを保存する。各partの開始・結果確定は有効なclaimと順序を再検査する。取消時は開始済みpartの確定だけを許し、親を復帰させない。
- 設定OFFの取消はID順の上限付きbatchで親をlockし、単件取消と同じ更新を使う。対象を全件メモリへ載せず、開始済みpartの判定は親lock取得後のstatementで行う。全batchを設定と同じtransactionに保ち、途中commitで原子性を分割しない。
- 保持期限後の整理も上限付きbatchで処理し、呼出元へは状態別件数だけを返す。batchを跨いで対象行を蓄積せず、元の保持期限・進行中の除外・恒久identityの保全を維持する。
- 通知IDの生成・入力検証・運用pathの検証は`@momo/db/notifications`の共通helperを使う。payload versionと既存IDの内容照合は受付の責務として分離する。
- リンクoriginの検証はdomainの共通制約を使い、設定・保存計画・rendererで同じ判定にする。DB repositoryは表示用のリンクbuilderへ依存しない。
- A/BのFAILEDは起動時に復帰させず、保持中で取消条件のない行だけを明示retryする。期限回収・保持もfamilyを限定し、既存Session回復と混ぜない。
- DB driverの例外には生payloadやSQL bindが含まれ得るため、result portは安全な分類だけを境界へ返し、元のcauseをlog・HTTPへ渡さない。

旧resultの部分計画にdelivery contextがない場合は宛先を推測して再送しない。旧rendererを撤去する条件と移行手順は[通知運用](operations/result-notifications.md)に従う。

## 8. Legacy reminder marker bridge

旧claim-first reminder経路が残したmarkerは、migrationで書き換えず監査値として保持する。`DECIDED`かつreminder dueのSessionはmarkerの有無で除外せず、現在のoutboxへenqueueする。外部送信済みか不明な場合は、重複を許容して欠落を避ける。

この互換処理は次をすべて満たすまで削除しない。

1. 対象となる全環境が現在のoutbox migrationを適用済みである。
2. production auditで旧経路由来の`DECIDED` reminder markerを持つ未完了Sessionが存在しない。
3. startup/recoveryのcontract testから旧marker fixtureを外しても、旧versionからupgradeするsupported pathが残らない。
4. 撤去PRに監査結果、rollback方法、migration compatibilityの確認を記録する。

日付だけ、または「しばらく問題がなかった」だけを撤去根拠にしない。

## 9. Migration protocol

1. `requirements/base.md`と設計文書で必要な契約を確認する。
2. `../momo-db/docs/development.md` に従って migration の分類、生成、SQL review、fresh / existing DB 検証、commit を行う。
3. Summit側のconsumer codeとreal DB integration testを更新する。
4. backupとdeploy禁止窓を確認する。
5. momo-db の production approval と migration 完了を確認してからapplicationをdeployする。

互換期間が必要な変更はexpand→application→contractの順で行う。migrationに曖昧なbusiness state修復を混ぜず、危険な既存dataはfail-closed preflightで停止する。

所有者が停止切替を選んだ共有通知の再構成は、momo-db の正規文書に従い全 writer・配送を止めて DB と consumer を一括で切り替える。開催履歴・参加者・試合を保全し、既存アンケートの reminder completion を確認してから再開する。

## 10. 変更時の検証

変更で影響を受ける契約について、次の観点と `docs/test-rule.md` の品質 gate を適用する。DB 契約変更の real DB 検証は省略しない。

- real portとfake portのcontractが一致する。
- unique、CAS、transaction rollback、lock orderをreal DB integration testで確認する。
- concurrent interaction、deadline、cancelが一つのwinnerへ収束する。
- outbox dedupe、Session内順序、claim lost、dead-letter cancellation/recoveryを確認する。
- Discord受理後のcompletion失敗で欠落ではなくretryへ進む。
- migrationはmomo-dbの正規文書が要求する証拠と、Summit consumerのcontract checkを通す。
- `pnpm verify:forbidden`でraw SQL、runtime DIRECT_URL、pushを検出する。
