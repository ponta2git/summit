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
| 性能・セキュリティ・高 | 最大本文を同時受付し、JSON 内に大量の空 object・深い配列・不正要素を入れる | 受付全体の byte 予約を DB settlement まで保持。parse 前の構造・深さ制限と配列の最初の不正での打切り。[受付容量](../tests/notifications/http.lifecycle.test.ts)、[悪性構造と8MiB近傍の正当入力](../tests/domain/notificationJson.test.ts) |
| 性能・セキュリティ・高 | 小さな指数表記を DB で巨大な decimal へ展開させる、旧 ID の内容照合を同時に行う | SQL 前の数値展開作業量と SQL 内の正規化 byte 数を別々に制限。旧容量での内容照合もストレス対象とする。[数値予算](../tests/domain/notificationNumericBudget.test.ts)、[実 PostgreSQL との境界比較](../tests/integration/notificationNumericBudget.test.ts) |
| 性能・信頼性・高 | 上限内の長いメモや Markdown 記号だけのメモで、正規表現の作業領域を増幅させる | hash は有限走査と逐次更新、escape は断片単位。保存 identity と全文・Unicode を維持。[hash](../tests/notifications/hash.test.ts)、[実 DB の最大近傍](../tests/integration/resultNotifications.transactions.test.ts)、[escape 境界](../tests/features/result-notifications/text.test.ts) |
| 性能・中 | 完了 Session を蓄積し、wake ごとに全件 CASE 集計を実行させる | status / 時刻 index の先頭を別々に取得。[1万件の実行計画](../tests/integration/schedulerQuery.performance.test.ts) |
| 性能・信頼性・高 | 保守 backlog で family lock を保持し、配送 heartbeat を待たせる | 件数・pass 上限と batch ごとの commit、集合 SQL。[retention](../tests/integration/notifications.retention.test.ts)、[real / fake の保守上限](../tests/contracts/attendance.ts) |
| 性能・信頼性・中 | 起動時 dead-letter の全 ID を IN 引数・メモリに展開する | Session の keyset page、DB 内の集合更新、同一チェーン原子性。[複数ページ](../tests/integration/outbox.recovery.capacity.test.ts) |
| 信頼性・高 | A/B 受付を連続させ、毎回 timer を後ろへ張り直す | 予約済みの最早 wake を保持。[dispatcher](../tests/scheduler/resultNotifications.test.ts) |
| 信頼性・高 | 出欠の hint / tick / 次時刻取得を一度だけ失敗させる | 有限 backoff、成功 reset、supervisor による再開。[controller recovery](../tests/scheduler/controller.recovery.test.ts) |
| 信頼性・高 | Discord の rate-limit 待機で出欠 claim の期限を超える | 両 family の共通 heartbeat、期限切れ owner の復活禁止、renew の settlement。[配送所有権](../tests/scheduler/outboxWorker.ownership.test.ts)、[real / fake 契約](../tests/contracts/attendance.ts) |
| 信頼性・中 | Discord 受理後の DB 失敗で短時間再送する | 通知 / part の安定 nonce、begin / finalize fencing。[配送所有権](../tests/scheduler/outboxWorker.ownership.test.ts) |
| 信頼性・高 | stop / drain の先頭で同期 throw、destroy を遅延・reject させる | 全 owner を呼び、非同期 destroy 完了を待つ。[lifecycle](../tests/runtime/lifecycle.test.ts)、[shutdown](../tests/shutdown.test.ts) |
| 信頼性・中 | metrics を失敗させる、cron 登録を途中で失敗させる | 観測と回復の失敗分離、登録済み task の回収。[cron lifecycle](../tests/scheduler/cron.lifecycle.test.ts) |
| 信頼性・高 | Session row / advisory lock を保持して出欠 transaction を待たせる | transaction-local の SQL / lock deadline、rollback 完了後の再利用。[実 DB 期限](../tests/integration/transactionLimits.test.ts) |
| 信頼性・高 | DB commit 後に公開 edit を失敗・遅延させる | commit → wake → best-effort edit。legacy CANCELLED / startup も同じ区別。[commit 後の失敗](../tests/discord/committedTransitions.test.ts)、[起動回復](../tests/scheduler/reconciler.transitions.test.ts) |
| 信頼性・中 | 開催確定後の編集で clock を進め、reminder skip を誤判定させる | 判定・必要な開催履歴の確定に同じ snapshot を使う。[確定処理](../tests/discord/committedTransitions.test.ts) |
| 信頼性・中 | `/ask` の二度の clock 読取を週境界にまたがせる、別 context を同時実行 | snapshot と in-flight 所有を AppContext に閉じる。[募集](../tests/discord/ask/send.test.ts) |
| 信頼性・中 | `/status` の過去警告を大量に蓄積し、本文上限を超える | 行単位の制限・省略件数・現在週と合計の保持。[status](../tests/features/status-command/viewModel.test.ts) |
| 信頼性・低 | 実在しない日付、0〜99年、完了済み開催の再描画 | 厳密な ISO date と確定時刻の保持。[日付](../tests/time/jst.test.ts)、[view model](../tests/discord/ask/viewModel.test.ts) |
| 信頼性・保守性・低 | 表示 test と計算用の負定数を共有し、「-15分後」を正当化 | lead は正値、減算は計算箇所だけ。独立した期待文面。[reminder](../tests/features/reminder/delivery.test.ts) |
| セキュリティ・中 | 表示名へ everyone / role / 設定外 user の mention を埋め込む | 既定禁止と固定 member 許可リスト、edit も明示。[mention policy](../tests/discord/mentionPolicy.test.ts) |
| セキュリティ・中 | 未認証の header を完了せず接続を占有する | 接続からの絶対期限、接続上限、stop 時の回収。[connection](../tests/notifications/http.connections.test.ts) |
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
| 保守性 | module 境界、再利用、原因分析、変更容易性、テスト可能性 | parser / heartbeat / lifecycle の責務集約、real / fake 共通契約、決定論的 race、検証器と実行 image の検証 |

負荷上限の正本は [config](../src/config.ts)・[notification config](../src/notifications/config.ts)、JSON の構造と schema は [payload parser](../src/domain/resultNotificationPayload.ts)。有限であることだけを理由に、すべての最大 payload の組合せが任意の process メモリ容量に収まるとは扱わない。

### 実行メモリの容量契約

標準の新規受付上限は分析 JSONB text 256 KiB、OCR 16 KiB、HTTP 本文512 KiB、受付全体1 MiB、50試合・16シーズン、名称256・表示名32・メモ150 Unicode コードポイント、分析128投稿とする。OCR の一投稿・既存の文脈名201コードポイント制約も維持する。配送は最大2件、取得・保持中の payload 合計512 KiBに収める。設定の正本は [notification config](../src/notifications/config.ts)。上限超過は永続受付前に拒否し、旧通知だけは以前の容量・本文・分割を保ち、予算を超える payload を単独配送する。

合格条件は Node 24 / Debian の本番 image を256 MiB・swapなしで実行し、標準ケースの cgroup memory peak を192 MiB以下に収めること。通常の小さい通知、最大近傍の Unicode、Markdown 密集の50試合・16シーズン、最大本文の2受付と2配送の重複、旧容量近傍まで数値展開する異内容の4同時受付、5連続 burst、容量・件数超過の拒否を実 DB で検証する。全17通知の全part配送確定まで確認する。旧8 MiB近傍の通知は別 container で単独配送し、全partの計画と最初の一投稿の配送確定、同じ4同時受付を測定する。残りのpartが未配送であることを確認し、全partのDiscord送信負荷を測ったとは扱わない。

最新の実装比較と容量結果は [性能レポート](./performance.md) に記録する。2026-10-02の標準ケースは146.71 MiBで合格。旧巨大通知と4競合受付の別ケースは193.21–196.60 MiBで比較目標192 MiBを超えたが、256 MiB内で完了した。この条件のpeak改善は確認できていない。

2026-09-29、最新 source から build した `summit-runtime-standard-check`（image ID `8843a4795286`）と local PostgreSQL 18で、次の結果を得た。

| ケース | cgroup peak | Node最大RSS | 配送の検証範囲 |
|---|---:|---:|---|
| 新規標準 | 147.30 MiB | 190.18 MiB | 17通知・932投稿を全件確定。5連続burst、拒否9ケース |
| 旧容量の単独配送 | 191.00 MiB | 233.05 MiB | 8,823投稿を計画、先頭1投稿を確定、残り8,822投稿はPENDING |

標準ケースは192 MiB以下の必須目標を達成した。本文は正規化後261,691 byte、HTTPは524,288 byteを使用し、配送時の取得batchは最大523,382 byteだった。両ケースで正規化後8,006,627 byteになる異内容の4受付を重ね、409と保存状態の不変を確認した。旧通知本体は8,382,648 byteで、他の配送との同時claimを許していない。旧ケースも今回の測定では192 MiB以内だったが、目標との差は約1 MiBにとどまる。標準ケースの余裕と同等には扱わない。RSSとcgroupは計上対象が異なるため、値を合算・同一視しない。

fixture 生成と負荷 client は container 外に置き、計測には本番依存・非 root の image と実 DB を使う。起動後の baseline 取得時だけ GC を実行し、負荷中に手動 GC を挟まない。cgroup peak はコンテナ全体の高水位であり、host の負荷生成と別コンテナの PostgreSQL は含まない。Discord への実接続・長期 cache・heap 断片化・出欠の同時最大負荷はこの代表ケースに含まない。

速度・CPU・heap の診断、旧8,823投稿の全件確定、100通知の連続負荷は[性能レポート](./performance.md)で別に測定する。上表は容量gateの結果であり、追加のprofile採取やCPU quota付き計測の数値と混在させない。

payload 上限、配送並列数、文字列処理、VM memory を変える場合は [容量検証器](../scripts/verify/notificationCapacity.ts) を `pnpm verify:notification-capacity <local-image>` で再実行する。[fly.toml](../fly.toml) は256 MiBとし、標準負荷の検証条件に合わせる。設定 file の更新だけでは稼働中 Machine を変更せず、実際の deploy は運用手順と別の権限に従う。

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
