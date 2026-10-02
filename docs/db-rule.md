# Database Rule

Summit が共有 PostgreSQL を使うときの所有権・原子性・再送契約を定める。出欠は §3〜5、OCR・分析通知（A/B）は §6、詳細削除は §7、schema 変更は §1・§9 を読む。業務上の状態と期限は [requirements](../requirements/base.md) が正本。

## 1. Schema と migration の所有権

schema、migration 履歴、Drizzle 設定は sibling [momo-db](../../momo-db/) が所有する。Summit は consumer であり、`src/db/schema.ts` の shim に schema 定義を複製せず、migration tool を追加しない。`drizzle-kit push` は使わない。

schema / migration を作成・変更するときは、**着手前に [momo-db の開発手順](../../momo-db/docs/development.md) を全文読む**。対象 DB の migration 状態も確認する。checkout がない、手順と実態が矛盾する場合は、それに依存する authoring / 適用を進めない。Summit 側で代替手順を推測せず、独立した consumer 調査は続ける。

runtime は pooled `DATABASE_URL` を使い、migration 用の unpooled `DIRECT_URL` は momo-db の経路に限定する。本番 migration は app deploy と独立して先に適用し、Fly release command へ組み込まない。sibling の配置と build 順序は現在の package 構成に合わせる。consumer が増えて配置が制約になったときに package 配布を再評価する。

## 2. DB に残す不変条件

Session、Response、HeldEvent、notification intent が状態の正本。Discord の失敗で確定済み DB を巻き戻さず、再実行時は現在の DB から回復する。process 内 lock や事前 read だけで、次の制約を代替しない。

| 対象 | DB が守る契約 |
|---|---|
| Session | week と順延区分の unique、許可された状態 |
| Response | Session + member の unique |
| HeldEvent | Session との unique な対応、確定時点の参加者 |
| notification | 全 status を通じた dedupe identity |
| 出欠 intent | Session revision + ordinal の一意性と順序 |
| 関連 row | FK / check / status 制約。途中状態を別々の commit に分けない |

DB client は parse 済み設定と `src/db/client.ts` の pooler 設定を使う。値は parameter 化し、user input を `sql.raw` に渡さない。動的 identifier / order が必要なら allowlist で固定する。接続文字列・SQL bind・driver の未加工 error は log / HTTP に出さない。

集約の書込は [runTransaction](../src/db/transaction.ts) で READ COMMITTED と transaction-local の lock / statement timeout を設定する。timeout は rollback の完了まで owner が待ち、次の pool 利用へ設定を漏らさない。これは SQL ごとの制限であり、任意の件数の loop 全体や network 待機の上限ではない。保守処理は下記の batch 境界でも制限する。

本番データを手動の INSERT / UPDATE / DELETE / TRUNCATE / DROP で修復しない。application の回復経路、履歴付き migration、該当 [runbook](./operations/README.md) を使う。local reset は [開発規約 §8](./dev-rule.md#8-local-db) の guard 付き経路を使う。

## 3. Port と書込の所有者

[port interface](../src/db/ports.ts) を consumer 契約とし、実装と fake を揃える。handler が複数の低水準 write を組み合わせて集約 command を再実装しない。

| Port / 操作 | 所有する単位 |
|---|---|
| Sessions | read、作成、message ID 保守、scheduler hint。業務遷移は持たず、初回 message ID は null 条件の CAS で保存 |
| SessionCommands | Session lock 後の member・回答・締切・状態判断と、Response・状態・revision・intent の一括確定 |
| HeldEvents | DECIDED の完了と開催履歴・参加者の同時確定。参加者はその Session の回答から得て、現行 config から再生成しない |
| Outbox | 出欠 family の enqueue、claim、配送確定、回復、retention。message 欠落の復旧判断は SessionCommands に委ねる |
| ResultNotifications | A/B の raw JSON 受付、設定、配送、inspect / retry、retention。§6 の共有 DB 契約を守る |
| Status | `loadCurrentWeekSnapshot` で Session / Response / HeldEvent をまとめて取得。join の知識を閉じ、他 port に画面都合の汎用 batch API を増やさない |

cancelled / skipped を開催履歴にしない。必須通知 intent は、その原因となる集約変更・作成と可能な限り同じ transaction に置く。notification の parent / relation / parts は共有保存構造を使い、出欠の relation と A/B の relation を混同しない。業務判断の所有者は application command とし、DB function / trigger へ移さない。

## 4. 競合時の判断

read-modify-write は transaction と期待値付き CAS で閉じる。競合負けは typed result として返し、必要なら最新状態を表示する。古い Interaction snowflake が新しい Response や aggregate revision を上書きしないよう fencing する。ask の process 内重複抑止に加え、DB unique を最終防衛線とする。

`cancelWeek` は Session を決定論的な順序で lock する。金曜 Session の lock 待機中に土曜が作成され得るため、**金曜 lock の取得後、別 statement で週全体を読み直す**。Session がない場合も sentinel で後続作成を抑止し、週 skip、競合 intent の取消、通知 intent を一 transaction で確定する。Discord I/O は transaction の外で行う。

根拠は [SessionCommands](../src/db/repositories/sessionCommands.ts) と [金曜 lock 待機中の順延テスト](../tests/integration/cancelWeek.postpone-race.test.ts)。fake で SQL lock / MVCC を証明した扱いにしない。

## 5. 出欠 outbox

### Identity と順序

必須の新規投稿は typed intent として保存する。対象は実装済みの募集・順延・締切収束・投票・決定・reminder・週取消であり、未実装 kind を先回りして追加しない。

同一集約は revision / ordinal 順に処理し、先行 PENDING や dead-letter を飛ばさない。dead-letter の後続は取消し、dedupe identity は終端状態でも保持する。retry のために別 row を作らない。

不正 payload / 状態や未対応 renderer は FAILED（dead-letter）にする。claim transaction 内の不正 row は item 単位で隔離し、他 Session の正常な claim を巻き戻さない。`/status` は保存状態から集計し、本文を parse しない。claim / read / cancel / parts は必要な projection を使い、一度取得した batch 本文を無目的に読み直さない。projection の最適化でも validity と fencing を落とさない。

### 配送の境界

| phase | 契約 |
|---|---|
| claim | token で owner と期限を定める。共有 `notifications.dispatch` では family と処理中 ID の除外を維持する |
| send 直前 | begin で有効 claim・取消・期限を再確認する。失効 / claim loss なら送信しない |
| render / send / 確定待機中 | heartbeat が token・family・status・未失効条件付きで renew する。失効済み owner は復活させない |
| send 後 | 有効 owner だけが CAS で確定する。旧 owner の確定は no-op |
| 初回 message | null 条件の CAS で canonical message ID を保存する |
| retry / 次回起動 | retry limit は config。PENDING の retry と claim expiry を分けて次時刻を得て、終端履歴全体を毎回 scan しない |

Discord と PostgreSQL の原子的 commit はできない。受理後・DB 確定前の停止や claim expiry では外部投稿が重複し得るため、欠落回避を優先する。DB fencing を exactly-once 配送の保証と表現しない。

両 family とも通知 ID / part から安定 nonce を生成し、Discord の短時間の重複抑止を利用する。nonce の保持期間を越えた配送保証には使わない。時刻取得は状態を書き戻す境界でも行う。

reminder tick は enqueue までを行う。Discord 受理後に Session 完了と HeldEvent を原子的に確定し、その後 delivered を記録する。送信 skip の経路も同じ完了 command を使う。再送の可能性があっても、開催履歴を欠落させない。

### 回復

期限切れ claim は試行数に応じて PENDING / FAILED へ戻す。回収と後続取消は上限付き batch の集合更新とし、残件は次回の dispatch / supervisor で拾う。FAILED chain の再投入は startup に限定し、Session のページごとに family gate を解放する。同一 Session の attempt と失敗に伴う後続取消は同じ transaction で戻し、通知全件の ID 配列を作らない。手動取消と A/B は復活させず、reconnect / tick の hot loop にしない。

message ID が null の候補は、Session lock 後に現在の状態と ID を再確認してから予約 ordinal の intent を補う。古い候補 read だけで enqueue しない。`UnknownMessage` の best-effort 再作成は [Discord 規約 §5](./discord-rule.md#5-永続化後の表示更新)。

実装と契約例は [outbox repository](../src/db/repositories/outbox.ts)・[attendance 共通契約](../tests/contracts/attendance.ts)・[outbox integration](../tests/integration/outbox.contract.test.ts)。運用 retry / 観測は [outbox runbook](./operations/outbox.md)。

## 6. OCR・分析通知の保存と取消

[共有通知契約](../../momo-db/docs/discord-notifications.md) と [ResultNotifications 共通テスト](../tests/contracts/resultNotifications.ts) を使う。A/B は Session に従属せず、出欠の再投入・retention・claim release に混ぜない。

### 受付と generation

受付では parent、固定 payload、result relation、取消対象と PENDING / CANCELLED を一 command で確定する。OCR v2 / analysis v1 の version を**既存 ID との照合より先に**検証し、同一 ID でも旧 OCR の再受付を拒否する。受け取った schemaVersion を保存する。

content hash は JSONB と互換な数値・文字列の扱いを維持する。JSON の decimal を JS number へ丸めてから同一性を判断しない。通知 ID の生成と ops path の検証は `@momo/db/notifications` に集約し、ID の形と version / content の受入可否を別々に判断する。

JSONB text の hash は引用文字列を順次走査し、引用外の数値の末尾 scale だけを除いて逐次更新する。巨大メモ全体を正規表現の反復 alternation で保持しない。過去の hash vector と上限近傍の受付・重複判定で identity の互換性を検証する。

新規 ID は掲載件数・文字数と描画後の投稿数を受付前に検査し、上限超過を `payload_too_large` とする。描画検査は application context から port factory へ注入し、repository を renderer に依存させない。DB へ渡す前に文字列外の数値 token の展開 byte 数を合算し、種別別の正規化予算を超える場合は拒否する。重複 key で後から破棄される数値も作業量に含め、小さい指数表記による DB 内の巨大展開を抑える。その後 PostgreSQL の正規化済み `jsonb::text` の UTF-8 byte 数も確認し、超過した本文は Node へ返さず、parent / relation / targets を保存しない。上限の正本は [notification config](../src/notifications/config.ts)、境界の根拠は [受付上限 integration](../tests/integration/resultNotifications.limits.test.ts)。

対応 version の既存 ID は新規制約より先に旧容量で hash を照合し、詳細整理後も同内容の重複と異内容の conflict を維持する。ただし HTTP 本文上限と数値展開の作業量制約は重複にも適用するため、旧容量の本文や大量の重複 key をそのまま POST できる保証ではない。保存済み通知の配送・ID 指定 retry は新規の件数・文字数・投稿数制約を適用せず、旧 renderer 契約を維持する。共有 schema / producer の上限は変更しない。

ON / OFF、generation 更新、未開始通知の取消を原子的に行う。momo-result API も共有 DB を直接更新し、Summit の起動を設定変更の前提にしない。receipt / begin / retry は共通 result gate を経由して commit 済み generation / OFF を観測する。

### Lock 順序と取消

`notificationTransaction` は READ COMMITTED と family gate を使う。source の業務 write を先に済ませ、末尾で result gate と通知取消へ進む。gate 後に source row lock を取り直さず、Discord I/O を入れない。consumer 間の lock 順序は共有契約に合わせる。

OFF は通知 ID 順に parent を bounded batch で lock し、**lock 取得後の statement で開始済み part を確認する**。全 batch と設定更新は一 transaction に含める。途中 commit と全 backlog の一括メモリ読込を避ける。

取消は新しい part の開始を止める。開始済み part の結果保存は許すが、親通知を復活させない。

### 配送と互換性

最初の plan で renderer、part 数、origin、channel を固定する。各 part の開始・確定は有効 claim と順序を検証する。origin 検証は config / plan / renderer で共有し、DB 層を表示 link builder に依存させない。

配送 query の集約でも family gate 取得後の新しい statement で取消を確認する。begin は前の未完了 part がないことと対象の PENDING を条件付き UPDATE で検証する。complete は part の DELIVERED 更新後、別 statement で残件を確認して親を確定する。同一 statement 内の更新 CTE と残件照会が更新後の状態を読めるとは仮定しない。

claim は payload 本文を取得する前に DB 内で正規化 byte 数を調べ、実行中の通知を含む byte 予算と配送 slot の両方に収める。予算より大きい既受理 payload は、他に実行中の通知がない場合だけ単独で取得する。配送中に保持する予算は実処理の settlement まで解放せず、予算待ちの due row を短周期で再取得しない。本文は part 数を先に数えてから一投稿ずつ生成し、全投稿の文字列配列を保持しない。

claim の part 情報は昇順・重複なしの配送済み番号に限定する。番号の欠落を許し、連続した prefix と決めつけず再開する。inspect は status・試行回数・message ID を含む詳細を維持する。

claim / 次時刻取得 / inspect / retry は同じ対応 version を扱う。退役 OCR の既存 identity は維持し、通常配送や retry に戻さない。A/B の FAILED は期限内・未取消の明示 retry だけを許し、startup で自動復活させない。ResultNotifications port は DB driver error を安全な分類へ変換し、raw payload / bind / cause を HTTP や log に漏らさない。

古い plan に delivery context がなければ宛先等を推測して再送しない。renderer 互換を残す条件と停止切替は [A/B runbook](./operations/result-notifications.md)。受付・設定競合・rollback の根拠は [実 DB テスト](../tests/integration/resultNotifications.transactions.test.ts)。

## 7. Retention と観測

active notification は削除対象にしない。終端状態ごとの policy で payload / parts 等の詳細だけを削り、ID・dedupe・content hash・終端状態は恒久保持する。詳細削除済み FAILED を retry で復活させない。

retention deadline と consumer cutoff の両方を満たす対象を、上限付き batch ごとに原子的に処理する。batch 間では commit して family gate を解放し、配送・renew を進める。一回の保守で処理する batch 数も有限とし、残件は次回の retention に残す。途中失敗しても前の batch の確定を巻き戻さないが、一通知の parent / parts / targets を部分削除しない。backlog 全件をメモリに読み込まず、status 別件数を返す。上限の正本は [notification config](../src/notifications/config.ts)、根拠は [retention integration](../tests/integration/notifications.retention.test.ts)。

scheduler hint は状態・時刻の索引で各最小値を取得する。終端履歴全体に CASE 集計を掛けない。[実行計画テスト](../tests/integration/schedulerQuery.performance.test.ts) は多数の終端行を入れ、実際の query が必要な索引先頭だけを読むことを確認する。

pending / in-flight / failed の件数と経過時間を観測する。`/status` は read-only を保ち、配送・再投入・詳細 parse を行わない。log の形式と秘匿境界は [Architecture §7](./architecture.md#7-設定と観測)、障害判断は該当 runbook が所有する。

## 8. 旧 reminder marker の互換性

旧 reminder marker は監査情報として保持し、migration で書き換えない。DECIDED かつ reminder due の Session は marker の有無にかかわらず現行 outbox へ enqueue する。移行時の重複を許容し、未完了の開催履歴を回復する。

互換処理を撤去するには、全環境が対応 migration 済みであること、本番監査で旧 marker に依存する未完了 Session が残っていないこと、対応 upgrade 経路が旧 fixture を必要としないことを確認する。PR に監査・rollback / compatibility の根拠を残し、日付だけを撤去条件にしない。

## 9. Migration と deploy の接続

authoring は §1 の手順に従い、requirements / 設計から必要な変更を特定する。momo-db 側の分類・生成・SQL review・新規 DB / 既存 DB の検証を行い、Summit の consumer と test を揃える。適用は [migration runbook](./operations/migration.md) に従う。local な文書・実装変更の完了条件に本番適用を追加しない。

通常は expand → app 更新 → contract の互換順序を使う。業務状態を推測して修復する migration は作らず、危険な既存データは preflight で fail-closed にする。

停止切替が必要な場合は、対象操作の権限・backup・禁止窓を確認し、全 writer と配送を停止する。開催履歴・参加者・試合を保全し、reminder の完了を確認してから再開する。

DB 契約を変えたときは [テスト規約 §6](./test-rule.md#6-変更種別ごとの必須テスト)・[§8](./test-rule.md#8-quality-gate) の real DB 検証まで行う。文章の整理と DB 契約の変更は区別する。
