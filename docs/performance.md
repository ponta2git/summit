# 通知処理のパフォーマンスレポート

通知の容量・処理速度・CPU・heap を判断するための測定記録。通知入力、配送処理、DB クエリ、Node / image、CPU / memory 条件を変えたら再測定する。上限の契約は [品質評価](./quality-assurance.md#実行メモリの容量契約) と [notification config](../src/notifications/config.ts) が所有し、本書は測定条件・結果・評価限界を所有する。

## 2026-11-01 通知の実所有とDB入場制御

SDKの送信・channel取得が45秒の待機期限を超えても、実Promiseのsettlementまで配送枠と元本文の予約を保持する。leaseは期限内の更新確認で同じclaimから再開し、通知DB transactionはfamily 2件・全体3件、待機を含むproducerは34件までに制限する。受付待機へは元JSONと最小metadataだけを渡す。timeout設定の不要なbindとbegin / completeの不要列も除いた。設計上の境界は[Architecture](./architecture.md#6-scheduler-と-lifecycle)と[DB規約](./db-rule.md#5-出欠-outbox)を正本とする。

### 比較条件と結果

変更前 `10f11fe` / image `4e399e99e95a` と、修正後 `6c7de44` / image `1c8a886711c6` を比較した。Node 26.13.0 / Linux ARM64、PostgreSQL 18.6、momo-db `0f102e4`、256 MiB・swapなし・1 CPU。各runに専用DBと新しいcontainerを用意し、実Pinoと固定容量histogramを使った。実Discordは代替送信、DB RTTは同じcontainerのTCP proxyで0 / 20 / 50 msを注入した。CPUにはproxyと計測処理も含む。

各RTTで新旧順序を反転する6組を事前に固定した。0 msで200通知のwarmupと1秒の自然待機後、新規20通知（同時2件）、既存duplicate 32要求、不正JSON 32要求を別々に計測する。詳細DB診断と定期的な `process.memoryUsage()` は主比較から外し、cgroup peakと測定境界のmemoryを記録した。peakには起動とwarmupを含む。通常p95と同一処理量CPUの初期許容幅+10%は変更していない。

| RTT ms | 測定対象 | p95 msの算術平均：変更前→変更後 | p95のペア比変化［95%区間］ | CPUのペア比変化［95%区間］ |
|---:|---|---:|---:|---:|
| 0 | 新規→配送完了 | 60.71 → 67.67 | +10.4%［-22.2, +56.6］ | +0.0%［-16.4, +19.8］ |
| 0 | 既存duplicate受付 | 22.21 → 14.78 | -32.9%［-44.4, -18.9］ | -6.7%［-29.5, +23.3］ |
| 0 | 不正JSON受付 | 6.99 → 7.16 | +2.1%［-16.0, +24.1］ | -17.7%［-38.8, +10.7］ |
| 20 | 新規→配送完了 | 2531.33 → 2514.94 | -0.6%［-6.6, +5.9］ | -6.5%［-23.3, +13.9］ |
| 20 | 既存duplicate受付 | 642.39 → 634.20 | -1.3%［-5.9, +3.6］ | -14.8%［-42.4, +26.0］ |
| 20 | 不正JSON受付 | 243.37 → 327.34 | +34.5%［+27.5, +41.9］ | +2.9%［-49.4, +109.3］ |
| 50 | 新規→配送完了 | 5570.56 → 5472.26 | -1.8%［-2.7, -0.8］ | -0.2%［-10.5, +11.4］ |
| 50 | 既存duplicate受付 | 1432.23 → 1377.62 | -3.8%［-4.3, -3.3］ | -8.6%［-29.0, +17.6］ |
| 50 | 不正JSON受付 | 552.96 → 711.34 | +28.6%［+27.2, +30.1］ | +15.9%［-36.7, +112.2］ |

通常負荷のp95 / CPUには95%区間の上限が+10%を超える条件があり、一括した非劣化は確認できていない。統計単位は独立したrunの6組で、対数比のpaired t・95%両側区間を使う。20,000回のpaired bootstrapは感度分析として別記した。各runの通常20件から求めるp95は粗い分位であり、全通知を独立標本として扱わない。上限が+10%を超える区間を合格や改善と読み替えず、複数指標の同時保証もしない。

不正JSONの4同時受付では20 / 50 ms条件のp95が+10%を超えて増加した。別の詳細診断でもDB入場待ちを観測した。family上限と既存の入力4xx / DB不通503の優先順を維持するため、短い拒否transactionにも同じ入場制御を適用する。未完了workの有限化、期限内回復、保持構造とSQL通信の削減を確認した一方、全条件の高速化は確認できていない。

全36runで各221通知（warmup200＋通常20＋孤立wire測定1）が完了し、各runの最大attemptは1だった。duplicate / 不正入力は各1,152要求を別に確認した。受付status・配送数・attempt・計測commandのassertionを満たし、histogram範囲超過と標準容量目標超過はなかった。

### SQLと保持量の確認

timing測定後にdispatcherを止め、他のDB workがない状態で1 partのbegin＋completeを別計測した。PostgreSQL protocolのFlush / Sync / Queryによる応答境界は **26→24**、SQL数は **16・2 transactionsのまま**。50 ms条件の合計所要時間は平均 **1411.5→1322.6 ms**、ペア比変化は **-6.3%［-7.1, -5.5］** だった。転送量と全ペアは[集計JSON](./performance/notification-reliability-20261101.json)に残す。この孤立比較はSQL変更の効果を示すが、4改善をまとめた通常処理のCPU差を候補ごとに分解した結果ではない。

受付のPreparedReceiptは解析木・renderer closure・元exceptionを保持せず、元JSON以外のidentityとDTOのJSON表現は制御文字のescapingを含め64 KiB未満、HTTP4件分でも256 KiB未満を検証した。これはheap全体の上限ではない。SDK / DBの保持件数と本文予約は障害時にも有限であることを確認し、単に同期処理を前へ移したことでevent-loop停止が短縮したとは主張しない。

### 最終imageの容量・障害・停止

標準17通知・932 partsは **124.45 MiB**、旧8 MiB近傍通知の8,823 parts計画・先頭1 partと4競合受付は **162.63 MiB** で、192 MiB目標を満たした。旧ケースの全part配送はこの容量gateの対象外。runtime imageの非root・read-only・本番依存検証も通した。

100秒のSDK未応答と実Pino出力停止では実未完了送信2件、attempt 1を維持し、出欠renewは10回進んだ。peakは62.35 MiB、滞留logは最大3,055 bytes。解除後に6通知が完了した。SDK成功8回には既存の不確実配送契約で許される2回の再送が含まれ、exactly-onceの根拠にはしない。実 `@discordjs/rest` とloopback APIによるHTTP 429 / Retry-After 50秒でも、48秒時点で未完了送信2件・attempt 1を保ち、解除後に全6通知が完了した。

子processのSIGTERM試験では、SDKとDBが各1件未応答でも20.114秒でdrain期限からDB close・client destroy・exitへ進んだ。DB gate取得前、gate保持中、更新後、COMMIT適用後の応答喪失は実DBで、20分の未応答・clock jump・timer遅延は仮想時間で検証した。外部サービスのPromiseを実際に取り消せるという意味ではない。

`pnpm run ci` は137 files / 1,010 testsが成功し、既存4ファイルの行数advisoryだけが残った。実DBの `pnpm test:integration` は31 files / 177 testsが成功した。途中で見つけたclaimテストの期待順と、JSON escapingを含むmetadata上限の説明・テストを修正し、最後にCIと実DB gateを通した。Opus 5.5 xhighのコードレビューと修正を2巡完了した。

### 再現性と残る限界

初回36run、修正後の詳細診断36run、別採取のCPU profile 1組、中断した修正前steady 16runを保持し、主比較36runへ混ぜていない。初回には診断scopeの引継ぎとTCP_NODELAYの計測器不備があった。別profileで定期memory計測のCPU負荷を確認し、主比較から外した。steadyの中断理由はHTTP待機期限の修正で、性能値による試行選別ではない。

生データ・再現harness・gate logは `artifacts/notification-performance/notification-reliability-20261101/`、hashと測定条件は[集計JSON](./performance/notification-reliability-20261101.json)に保存した。本番x64・実Discord / Gateway・Neon / TLS・長期稼働は未測定。通知枠を使い切るDB障害は有限停止となり、監視は自動復旧を保証しない。先行する出欠hint照会が未応答ならsupervisorも待つ既存の限界は[運用手順](./operations/result-notifications.md#遅延停止からの回復)で扱う。本番deployは実施していない。

## 2026-11-01 runtime のメモリ削減

date-fns の関数と日本語 locale を公開 subpath から import し、非 bundle 実行で不要な module の初期化を避ける。加えて [Dockerfile](../Dockerfile) の runtime stage に `MALLOC_ARENA_MAX=2` を設定する。build / 開発環境、JS heap 上限、256 MiB の VM 容量は変更しない。`verify:runtime-image` は image に埋め込まれた値と `date-fns/format`・`date-fns/locale/ja` の import を検証する。barrel import の再導入を検出する検査ではない。

採用理由は、限定 import 後にも allocator 設定による待機メモリの削減があり、CPU と peak が事前の許容幅内だったこと。p95 の非劣化は未確定だが、便益と残る性能リスク、復旧可能性を比較して条件付きで採用する。不存在の証明や、信頼区間がゼロを含むことだけを採否の理由にしない。適用後の観測と切り戻しは [運用手順](./operations/README.md#runtimeのメモリ設定) に従う。

### allocator の比較条件と結果

source `22e99aa` に今回と同じ限定 import を適用した一時 image を使い、環境変数だけを変えて比較した。Node 26.13.0 / Linux ARM64 / glibc 2.36、単一 CPU 固定（quota なし）、256 MiB・swap なし、非 root・read-only。各試行に新しい application / PostgreSQL container と専用 DB を用意し、実 Discord / TLS は代替送信とした。allocator 診断 addon は測定 image のみに含み、本番 image には含めない。

追加測定前に、既定値対 `=2` の12組、実行順6組ずつの反転、自然待機 Anonymous の便益2 MiB、通常 p95 / 同一処理量 CPU の悪化10%、peak 増加2 MiBという判定幅を固定した。幅は既存 SLO ではなく、低コストで可逆な設定変更への工学的判断。通常100通知と大きな10通知を4周（440通知・2,980 parts）、処理完了を待たない固定間隔の到着で負荷をかけた。warmup 後の開始点を除き、反復中に GC を強制せず、最後の10秒自然待機の8 / 9 / 10秒時点の Anonymous 平均を主指標にした。

予定24試行のうち既定側の1試行が3周目に HTTP 503となり、原因は未確定。再試行の成功で置き換えず、候補側単独の成功と失敗を記録した。効果値を見る前に完走した11組での解析へ変更し、実行順の不均衡も感度分析した。以下は完走条件での比較であり、欠測による選択バイアスや全試行の可用性を保証しない。

| 指標 | 既定 / `=2` の算術平均 | ペアの差・比変化［90%区間］ | 事前幅での判断 |
|---|---:|---:|---|
| 自然待機 Anonymous MiB | 74.31 / 69.11 | −5.20［−7.01, −3.39］MiB | 2 MiB以上の便益を支持 |
| 通常通知 p95 ms | 35.79 / 36.69 | +2.98［−6.11, +12.94］% | 悪化10%以内は未確定 |
| 同じ処理量の CPU ms | 7,623.7 / 7,532.1 | −1.22［−2.95, +0.54］% | 許容幅内 |
| cgroup peak MiB | 86.63 / 82.03 | −4.60［−6.42, −2.78］MiB | 許容幅内 |

統計単位は独立した11組。各試行の通常400通知から nearest-rank p95 を求め、メモリ差と p95 / CPU の対数比に paired t の90%両側区間（各端が片側95%限界）を用いた。block bootstrap 20,000回と順序を等重みにした感度分析でも判断は変わらなかった。遅い組・メモリが増えた組を除いていない。p95 の絶対差は平均+0.91 msだが、この事後集計で10%の判定幅を置き換えない。

診断 GC 後の heapUsed は32.291 / 32.282 MiBでほぼ同じ。一方、arena 数は9 / 2、arena 確保領域は19.96 / 14.61 MiBであり、JS 生存 object より allocator 側の保持・配置の変化と整合する。arena 統計と Anonymous / RSS は異なる会計であり、厳密な内訳として足し引きしない。

### 反復と評価限界

同じ process で30周を処理する補助試験は各設定1回、3,300通知・22,350 parts・約4.6分。各周の自然待機 Anonymous の10周ごとの中央値は、既定77.15 / 80.56 / 79.20 MiB、`=2` は70.50 / 73.21 / 71.31 MiBだった。初期に増えた後は上下し、候補の方が低い水準を保ったが、蓄積の抑制や数日間のリーク解消を証明したとは扱わない。最後の自然待機は74.43 / 71.47 MiB、通常 p95 は37.01 / 36.99 msだった。

A/A 2組でも p95 比は+7.85 / +11.23%と揺れた。`=1` の参考2組はメモリがさらに減ったが、peak 差が+5.43 / −9.15 MiBと振れ、最良とは判断しない。A/A、`=1`、30周を主比較の標本数へ加えない。計画34試行中33試行が完走し、warmup・中断試行を除く20,240通知・137,080 partsを検証した。候補の失敗0件から失敗率ゼロを推定しない。

本番 x64・実 TLS・長期稼働への効果量は未測定。起動時の限定 import の削減量と、この反復後の allocator の削減量を単純合計して本番を予測しない。メモリ逼迫の緊急対策ではなく、通常の可逆な最適化として運用する。生データに基づく公開用の[集計 JSON](./performance/runtime-memory-20261101.json)に、全ペア、判定幅、失敗、補助試験、元 artifact の hash を保存する。

根拠は [date-fns 4.4.0 の公開 exports](https://github.com/date-fns/date-fns/blob/v4.4.0/pkgs/core/package.json)、[glibc 2.36 の arena 制御](https://github.com/bminor/glibc/blob/glibc-2.36/malloc/arena.c)、[NIST の対応比較](https://www.itl.nist.gov/div898/handbook/prc/section3/prc311.htm)。Node / libc / CPU・通知負荷が変わった場合は容量 gate と比較測定を再評価する。

### 本実装 image の容量 gate

診断 addon を含まない本実装 image `4e399e99e95a`（Linux ARM64、momo-db `0f102e4`）を新しく build し、専用 local PostgreSQL で標準・旧巨大通知を検証した。標準17通知・932 partsの cgroup peak は **123.21 MiB** で、必須目標192 MiB以下を達成。旧8 MiB近傍の通知は8,823 partsを計画し、先頭1 partの確定と4競合受付を **172.19 MiB** で完了した。旧ケースの全part配送を確認した結果とは区別する。

容量 gate は各1回で、上の対比較とは image・計測方法が異なる。過去の単回値との差を改善量として扱わない。非 root・read-only・本番依存・format / ja の公開 subpath・image 内の allocator 設定の検査も成功した。imageのruntime入力は実装commit `f40407e` と同一で、その後の差分は検証器・文書に限定される。`pnpm run ci` の130 files / 963 tests、build、文書・禁止 pattern 検査が成功し、既存4ファイルの行数 advisory は残る。本番への deploy は実施していない。

## 2026-10-14 通知定義と runtime 注入の分離

配送 runtime へ取得元と配送 task factory を注入する構成に変え、出欠の業務確定・renderer と結果通知の種別・renderer版選択を通知定義へ寄せた。同期factory失敗と予約ID／byte数の変更の隔離を共通化した。出欠準備処理の遅延実行と、停止中にclaimが完了した後の新規task生成抑止も検証した。全変更のreviewと最終refactorを終えた凍結差分に対し、以下のgateと比較測定を実行した。

変更前 `d6998b4`／image `b168a1aca060` と変更後 `a2ccce4`／image `64a3c91befc3` を比較した。変更前imageは以前の実装commitとruntime・build入力197ファイルが一致することを確認して再利用し、候補は固定snapshotの全495 tracked filesが実装commitと一致することを確認した。Node 24.21.0 / Linux arm64、Node base digest `sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20`、momo-db `c6c32de`、新規の専用local PostgreSQL 18.4、256 MiB・swapなし・1 CPU、Discord代替送信を共通条件にした。計測器の変更はcompositionへのimport先1箇所だけで、負荷と観測方法は変えていない。

5ケースを各3組、新旧の順序を組ごとに交替して実行した。各ケースの最初の順序も交替し、全runに新規DB・containerを使った。各呼出しは `--repetitions 1 --rounds 5`。表は各variantの3runの全完了時間の中央値［最小–最大］と、cgroup peakの最大値を示す。

| ケース | 全完了の秒数：中央値［範囲］（変更前→変更後） | cgroup peak MiB：最大（変更前→変更後） |
|---|---:|---:|
| normal | 0.276［0.270–0.287］ → 0.290［0.270–0.309］ | 73.97 → 74.42 |
| parts | 13.526［13.188–14.280］ → 13.980［13.567–14.114］ | 92.51 → 92.39 |
| mixed | 5.808［5.693–6.453］ → 5.817［5.804–5.857］ | 92.55 → 89.44 |
| stream | 1.929［1.893–1.932］ → 1.918［1.900–1.934］ | 82.13 → 82.43 |
| legacyqueue | 99.002［97.264–107.814］ → 98.050［97.033–98.104］ | 141.09 → 147.87 |

normalの全完了中央値は約5.0%、partsは約3.4%増えた。両ケースの測定範囲は重なり、mixed・streamの差も小さかったが、一様な高速化や統計的な非劣化は主張しない。normalの受付→完了p95は61.61→61.28 ms。このp95は各run10通知のp95を3runでまとめた中央値であり、JSONに別記した30通知をまとめたnearest-rank分位とは区別する。

全30run・300通知・65,004 partsが完了し、投稿契約違反・予期しないアプリエラー・計測欠落はなかった。plan・begin・complete・yieldの回数は対応する新旧runで一致した。claimと次時刻照会には完了競合によるrun差があるため、全operation回数の一致とは扱わない。`mixed`・`stream`・`legacyqueue`は意図的な送信保留を含み、旧巨大通知の単独配送と先頭OCR→旧分析→後続OCRの順序も維持した。

容量gateは新旧各1回を別に測定した。標準17通知・932 partsのcgroup peakは **144.00→140.17 MiB** で、双方192 MiBの必須目標を達成した。旧8 MiB通知の8,823 parts計画・先頭1 partと4競合受付は **172.11→169.81 MiB**。単回の結果からメモリ削減や同等性を主張しない。`pnpm run ci` は129 files／978 tests、実DB integrationは27 files／144 tests、image build・非root／read-only／本番依存検証も成功した。本番deployは行っていない。

他agentのCI・DB検証を止めて比較したが、hostの背景負荷は完全には制御していない。DBと負荷clientはアプリcontainerの資源制限外で、実Discord／Neonの性能は未測定。全runの統計・実行順・raw SHA-256・環境・gate結果を[集計JSON](./performance/notification-composition-20261014.json)へ保存した。raw artifactとbuild snapshotは `/private/tmp/summit-delivery-composition-validation-20261014` に保持する。

## 2026-10-14 配送責務の分離

出欠と結果通知の配送 runtime を同じ階層へ移し、容量の予約・完了待ち・Scope、取得方針、単発／連番 Strategy、通知定義を分離した。出欠の batch 全件待ち、結果通知の2枠・512 KiBと随時補充、claim fencing・nonce・heartbeat・譲渡・停止時の確定順序は維持する。構造上の変更範囲は [Architecture](./architecture.md#6-scheduler-と-lifecycle) に記録した。性能改善はこの変更の達成条件にしていない。

変更前 `1ddfaef`／image `ee9249574efa` と変更後 `855fe17`／image `b168a1aca060` を比較した。runtime は固定した source snapshot から build し、候補snapshotの全488ファイルが実装commitと一致することを確認した。Node 24.21.0 / Linux arm64、Node base digest `sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20`、momo-db `c6c32de`、新規の専用local PostgreSQL 18.4、256 MiB・swapなし・1 CPU、Discord代替送信を共通条件とした。計測器の新旧差分は移動したmoduleのimport先だけ。各runに新規DB・containerを使い、`--repetitions 3 --rounds 5` で代表5ケースを実行した。

| ケース | 全完了の秒数：中央値［範囲］（変更前→変更後） | cgroup peak MiB：最大（変更前→変更後） |
|---|---:|---:|
| normal | 0.269［0.268–0.273］ → 0.314［0.294–0.398］ | 73.77 → 74.80 |
| parts | 13.922［13.337–14.287］ → 13.541［13.479–13.640］ | 88.57 → 92.20 |
| mixed | 5.784［5.733–5.868］ → 5.903［5.787–6.027］ | 93.23 → 90.22 |
| stream | 1.872［1.865–1.911］ → 1.915［1.895–1.976］ | 85.51 → 85.92 |
| legacyqueue | 101.229［99.322–136.745］ → 97.261［96.605–99.738］ | 148.43 → 140.19 |

初回normalは中央値が約17%増え、範囲も重ならなかったため、新旧を交互にした3組を追加した。追加分は **0.290［0.280–0.291］→0.282［0.273–0.296］秒**、CPU user＋systemの中央値は160.92→157.91 ms、受付→初回送信p95は51.09→51.72 ms、受付→完了p95は58.89→59.05 msだった。この段落のp95は、各run10通知のp95を3runでまとめた中央値であり、本文末の過去測定の集計定義とは分ける。順序を逆にした組も含め、候補だけが一貫して遅い傾向はなく、初回の遅延増は再現しなかった。初回は変更していないreceive・claim・plan等の時間も広く増加していたが、原因は確定していない。初回30runを除外せず、追加6runと分けて[集計JSON](./performance/notification-delivery-20261014.json)へ保存した。全36run・360通知・65,064 partsが完了し、投稿契約違反・予期しないアプリエラー・計測欠落はなかった。

plan・begin・complete・yieldの回数は対応する新旧runで一致した。claimと次時刻照会の回数は完了競合によるrun差があるため、全operation回数が同一とは扱わない。`mixed`・`stream`・`legacyqueue`は意図的な送信保留を含み、旧巨大通知の単独配送と先頭OCR→旧分析→後続OCRの順序も確認した。

最初の測定は変更前の全ケース、その後に変更後の全ケースを実行した。変更前は並行開発中のhost検証が重なり得る条件で、変更後と追加normalでは他のagentによるCPU・DB検証を止めた。DBと負荷clientはcontainerの資源制限外であり、外部負荷は完全には制御していない。速度向上・統計的な非劣化・本番Discord／Neonの性能を保証する比較ではない。raw SHA-256、run別の待ち時間・CPU・GC・operation統計と測定条件を集計に残した。raw artifactとbuild snapshotは `/private/tmp/summit-delivery-validation-20261014` に保持している。

容量gateは新旧各1回を別に検証した。標準17通知・932 partsのcgroup peakは **139.42→136.32 MiB** で、双方192 MiBの必須目標を達成。旧8 MiB通知の8,823 parts計画・先頭1 partと4競合受付は **171.43→180.88 MiB** だった。旧容量のpeakは増えており、単回の結果からメモリ削減や同等性を主張しない。`pnpm run ci` は126 files／964 tests、実DB integrationは144 tests、Docker build・非root／read-only／本番依存検証が成功した。本番deployは行っていない。

ローカルの既存`@momo/db`配布物にnested schema fileが欠落していたため、変更前snapshotでも745行の型エラーを再現した。frozen installによる生成済み依存の再同期後に変更前・変更後の型検査が成功し、manifest・lockfileは変更していない。再同期中に最初のlegacyqueue起動がmodule importで失敗したが、負荷開始前で測定artifactも未作成だった。失敗logのhashと理由を残し、復旧後の3runを採用した。

## 2026-10-12 保守性リファクタの検証

配送 Promise と予約 byte 数、timer と期限をそれぞれ一つの状態にまとめ、HTTP の接続管理と受付済み DB work の所有を分離した。DB の候補検索は共通 projection と family 固有の条件を整理し、SQL 数・lock 順序・公平配送の規則を維持した。計測の単回・複数回集計も共通化し、投稿 decile の分類を反復走査から一度の走査へ変更した。既存10ケース・30実行の再集計 JSON は変更前後で byte 単位に一致している。

直前の性能改善版 `a3dce91`／image `17d37a9b82d99` と、リファクタ版 `ae8e94f`／image `f08cdefff5bc` を比較した。計測器は `9469c71`、全測定開始時の working tree は clean。同じ Node 24.21.0 / Linux arm64・base image・momo-db `fdae7a5`・local PostgreSQL 18.4、256 MiB・swapなし・1 CPU、Discord 代替送信を使った。代表4ケースへ `--repetitions 3 --rounds 5` を適用し、ケースごとに新旧の実行順を入れ替えた。後述の10 round測定とは通知数が異なるため、直接比較しない。

| ケース | 全完了の秒数：中央値［範囲］（直前版→リファクタ版） |
|---|---:|
| normal | 0.244［0.242–0.282］ → 0.239［0.236–0.246］ |
| parts | 15.067［13.258–20.030］ → 12.745［12.650–13.816］ |
| mixed | 5.341［5.177–5.626］ → 5.567［5.534–5.598］ |
| stream：初回 | 2.338［1.870–3.547］ → 3.677［2.997–3.973］ |

normal の受付→完了p95は54.64→50.55 ms、mixed のOCR初回送信p95は64.98→71.95 msだった。mixed の全完了中央値は4.2%増だが測定範囲は重なる。一様な速度改善とは評価しない。

初回 stream は遅延が増えたため、同じ負荷を新旧交互の3組で追加確認した。追加分の全完了中央値は **1.762→1.741秒**、OCR初回送信p95は **263.49→148.76 ms**（各30通知）で、初回の悪化は再現しなかった。初回・追加の双方でplan・投稿・yieldの回数が一致し、OCRが到着順に完了した後に分析2件が完了する順序も同じだった。追加分では特定の版だけが一貫して遅い傾向も見られなかった。初回は変更していない DB command も広く遅くなっていたが、差の原因は確定していない。初回24実行を除外せず、追加6実行と分けて[集計JSON](./performance/notification-refactor-20261012.json)に保存した。計30実行・354通知・12,978 partsが完了し、投稿契約違反・予期しないエラー・計測欠落はなかった。代表ケースの確認であり、本番性能や統計的な非劣化を保証するものではない。

容量は新旧各3回を別に検証した。標準17通知・932 partsの cgroup peak は直前版137.30–138.26 MiB、リファクタ版 **138.35–140.59 MiB**で、全回192 MiB目標を達成。旧8 MiB通知の8,823 parts計画・先頭1 partと4競合受付は直前版170.65–174.49 MiB、リファクタ版 **172.16–189.81 MiB**だった。旧容量の peak 幅は広がっており、同等のメモリ使用量とは断定しない。保持予算・単独配送・受付上限は維持している。

HTTP単独の再確認は同じリファクタ版でcold／reuse各500要求×5回を行い、接続数500→5／回を維持した。cold要求p95 0.230 ms、再利用要求p95 0.097 ms。loopback・DB代替・TLSなしの測定で、前述のimage比較とは分ける。

`pnpm run ci` は122 files／943 tests、実DB integrationは27 files／144 tests、Docker build・runtime検証が成功した。正常配送の **16 SQL・2 transactions／投稿** も既存の実DB検証で確認。file-sizeは既存5件のadvisory。依存関係・共有schema・業務挙動は変えておらず、本番deployは行っていない。

## 2026-10-12 通知待ち時間の改善

**結果通知の即時wake、取消照会の集約、OCR／分析の公平配送、有限HTTP接続再利用を実装した。** 同じ計測器による各10ケース×3回の比較で、通常通知の受付→完了p95は **325.50→85.07 ms**、連続負荷は **5.212→3.841秒**、長い分析2件に後着するOCRの受付→初回送信p95は **1,313.95→67.32 ms** となった。本文・投稿数・2配送枠・512 KiB保持予算は変更していない。

旧runtime `b1ad65d`／image `96f5f34da7a3` と新runtime `a3dce91`／image `17d37a9b82d99` を比較した。Node 24.21.0 / Linux arm64、同じNode base digest `sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20`、momo-db `fdae7a5`、専用local PostgreSQL **18.4**、256 MiB・swapなし・1 CPU、Discord代替送信を使用。新実装の測定開始時は計測器commit `d9ed82e` でworking treeはcleanだった。これは複数の変更をまとめた比較であり、各最適化単独の寄与率や本番性能には換算しない。

| ケース | 全完了の秒数：中央値［範囲］（旧→新） | cgroup peak MiB：最大（旧→新） |
|---|---:|---:|
| normal | 3.138［3.113–3.256］ → 0.640［0.562–0.757］ | 91.32 → 132.69 |
| unicode | 10.798［10.443–11.055］ → 9.614［7.732–10.238］ | 92.41 → 99.36 |
| markdown | 13.507［12.789–14.036］ → 9.461［9.235–9.946］ | 95.68 → 90.81 |
| parts | 26.659［26.461–27.291］ → 27.570［25.026–31.546］ | 94.54 → 97.50 |
| overlap | 3.061［2.872–3.361］ → 2.058［2.049–2.113］ | 146.85 → 135.43 |
| legacy | 82.228［81.569–83.228］ → 81.045［80.841–82.245］ | 148.46 → 137.24 |
| soak | 53.297［52.245–55.992］ → 41.248［41.223–41.860］ | 105.88 → 102.73 |
| mixed | 15.579［15.461–15.610］ → 9.938［9.931–10.804］ | 91.10 → 96.12 |
| stream | 4.721［4.680–4.723］ → 2.043［2.010–2.043］ | 82.29 → 86.13 |
| legacyqueue | 92.120［89.931–98.134］ → 80.251［79.733–80.331］ | 175.69 → 150.48 |

warmupを除く採用60実行は計1,440通知・184,680 partsをDB確定まで処理し、OOM・投稿契約違反・計測欠落・予期しないアプリエラーはなかった。`overlap`・公平配送3ケースは意図的な送信保留を含む。`parts` の中央値は3.4%増え、範囲も重なるため、このケースの高速化は確認できていない。通常通知等ではmemory peakが増えたケースもあり、一様なmemory削減とは扱わない。[集計JSON](./performance/notification-speed-20261012.json)に各実行・種別別p50／p95／p99・最大待ち時間・処理量・event loop・raw SHA-256を残した。

`mixed` の分析完了p95は1.263→1.186秒だった。OCR連続到着の `stream` はOCR初回送信p95が3.681→0.206秒、全22通知の完了中央値が4.721→2.043秒。一方、分析完了p95は1.601→2.036秒へ延びた。OCR到着終了時に代替Discord送信が完了した分析投稿は旧77／78／78に対して新17／16／16で、分析は進むものの枠の譲渡によって遅くなる。これはOCR待ち時間とのトレードオフとして採用した。有限20件のOCR到着による観測であり、無制限負荷のSLAを示すものではない。旧大容量通知は途中譲渡せず、`legacyqueue` の全反復で先頭OCR→旧分析→後続OCRの順序と単独配送を維持した。

DB診断は速度測定から分離して6実行を採取した。正常20投稿と多投稿224投稿の双方で、begin／completeは **17→16 SQL・2 transactions／投稿** だった。224投稿ではDrizzleが記録したstatementが2,912→2,688、成功transactionのBEGIN／COMMIT推計896を合わせて3,808→3,584 SQLとなる。claim・plan・renew・yieldは別計上する。新 `parts` のyield確認は2回・16 SQL、新 `mixed` は4回・34 SQLで、公平配送には追加の照会・再取得が伴う。診断にはtransaction入口・gate呼出し・gate応答後からcommitまでのwall timeを保存した。SQLのserver実行時間・通信・純lock待ちへ分解した値ではない。`plan＋最初のbegin` 統合はchannel取得失敗時のrenderer／宛先固定境界を変えるため採用を見送った。[DB契約](./db-rule.md#6-ocr分析通知の保存と取消)

HTTP単独のloopback測定は同一候補receiver上のcold／reuseを各500要求×5回で比較した。1実行の接続数は500→5、cold要求p95は0.268 ms、再利用要求p95は0.111 ms、接続確立p95は0.043 ms。Node 24.19.0 / macOS arm64、DB代替・同一identityの重複受付・TLSなしであり、本番通信の短縮量を示さない。接続再利用は有限idle・要求数・受付予算と、異常時切断・shutdown drainの回帰検証を含めて採用した。

容量gateは標準17通知・932 partsで **141.64 MiB** と192 MiB目標を達成した。別containerの旧8 MiB通知は8,823 partsの計画・先頭1 partと4競合受付を **174.50 MiB** で検証した。`pnpm run ci` は121 files／939 tests、実DB integrationは27 files／144 tests、Docker buildと非root・read-only・runtime依存検証も成功した。file-sizeは5件のadvisory。取消、gate後のREAD COMMITTED可視性、claim fencing、開始済み投稿保存、譲渡rollback／応答喪失からの再開を維持している。本番deploy・実Discord／Neonでの性能測定は行っていない。

旧実装の最初の `legacyqueue` 試行は、編集中の計測検証がschemaから除かれる項目を比較して失敗した。負荷・probeは変更せず、生の計測結果から検証する確定版で同ケース3回を再実行した。成功済み27実行とこの3実行を採用し、失敗試行・元manifestのhashと除外理由を集計へ保存した。統合テストの初回はCIとの同時負荷で大量fixtureの2件が5秒期限を超えたが、負荷を分離した全suite再実行は成功した。いずれも失敗を成功sampleへ混ぜていない。

## 2026-10-11 Effect v4 移行後の検証

**Effect 4.0.2 への移行後、容量 gate と7ケース各3回の性能測定を完了した。** 対象は runtime `b1ad65d`、image ID `96f5f34da7a3`、momo-db `fdae7a5`。測定開始時の working tree は clean で、Node base digest は `sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20`。Node 24.21.0 / Linux arm64、専用の local PostgreSQL 18.6、256 MiB・swapなし・1 CPU、既存 fixture と Discord 代替送信で測定した。DB と負荷 client はアプリの resource 制限外にある。

容量 gate の標準17通知・932 parts は cgroup peak **138.79 MiB**で、必須目標192 MiBを達成した。別 container の旧8 MiB近傍通知は8,823 partsの計画と先頭1 partの確定に加え、8 MiB近傍へ展開する異内容4受付との重複を検証し、peak **172.25 MiB**だった。下表の `legacy` は旧通知の全件配送であり、この容量ケースとは負荷が異なる。

| ケース | 通知 / parts（1実行） | 全完了の秒数：中央値［範囲］ | cgroup peak MiB：最大 |
|---|---:|---:|---:|
| normal | 20 / 20 | 3.101［3.061–3.160］ | 77.42 |
| unicode | 20 / 1,140 | 12.352［12.185–12.410］ | 91.77 |
| markdown | 20 / 1,440 | 14.788［14.698–14.805］ | 96.12 |
| parts | 20 / 2,240 | 21.164［21.119–22.036］ | 97.73 |
| overlap | 4 / 228 | 3.092［3.062–3.154］ | 144.12 |
| legacy | 1 / 8,823 | 103.919［102.554–105.555］ | 130.01 |
| soak | 100 / 6,450 | 60.768［60.132–62.730］ | 101.70 |

warmup を除く21実行で555通知・61,023 partsをDB確定まで処理し、OOM・投稿契約違反・計測欠落・予期しないアプリエラーはなかった。全実行の通知単位 sample をまとめた受付→完了p95は normal **314.68 ms**、soak **5.854秒**。overlap の時間は意図的な送信保留を含む。

同条件のv3との比較とCPU / heap sampling profile採取は実施していない。過去の表とはDBなどの条件が異なるため、Effect単体の速度・memoryの改善率には換算しない。速度の合意済みSLOはなく、実Discord・Neon・Gatewayを含む本番性能は測定していない。再測定は専用local DBを指定し、`pnpm profile:notifications <image> --output <new-directory>` の当時の7ケース・各3回を再現できる。現在の既定ケースは後述の公平配送3ケースを加えた10ケース。

移行の品質 gate は `pnpm run ci` の116 files / 902 tests、実DB integration の26 files / 131 tests、Docker build・非root / read-only / runtime依存検証が成功した。file-size は既存4件のadvisoryのみ。API・エラー分類・resource所有権の契約は [Architecture §5](./architecture.md#5-非同期処理とエラー) を参照する。

## 2026-10-02 の最適化結果

**配送SQLの削減、待機中の不要なpayload参照の解放、結果投稿のSDK cache解放を実装した。** 1投稿の正常経路は20→17 SQL、2 transactionsを維持する。family gate後の取消確認、claim fencing、part順序、開始済み送信の結果保存も維持した。[DB回帰テスト](../tests/integration/notifications.delivery.test.ts)では112 / 8,823 partsの未完了検索が1回のscanであることを確認している。

claimは配送済み番号だけを取得し、inspectは詳細を残す。配送は同期の検証・描画準備後にraw payloadを手放し、完了callbackはIDとbyte数だけを保持する。結果投稿は送信成功時にそのmessageだけをcacheから除き、DB確定にはIDを渡す。全体の並列数、受付上限、SDK全体のcache、Fly 256 MiBは変更していない。

旧runtime `ab15042` と新runtime `b67cf9c` を同じNode base digest `sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6` でbuildした。image IDは旧 `f884975c12a2`、新 `77e68c5a1188`。Node 24.21.0 / Linux arm64、local PostgreSQL 18.4、256 MiB・swapなし・1 CPU、同一fixtureと計測probeで各7ケース×3回を比較した。probeの代替message cacheはSDKと同じ200件上限の最小 `{id}` objectであり、実SDKの保持byte数を再現していない。

| ケース | 全完了の秒数：中央値（旧→新） | 秒数の範囲（旧／新） | cgroup peak MiB：最大（旧→新） |
|---|---:|---|---:|
| normal | 3.190 → 3.137 | 3.141–3.208 ／ 3.128–3.184 | 100.93 → 79.96 |
| unicode | 12.204 → 10.342 | 12.098–12.836 ／ 10.212–10.530 | 94.83 → 96.56 |
| markdown | 17.231 → 12.536 | 14.743–17.943 ／ 12.102–12.651 | 98.21 → 97.71 |
| parts | 27.451 → 22.168 | 25.846–29.329 ／ 19.309–24.662 | 106.80 → 103.66 |
| overlap | 2.966 → 2.543 | 2.945–2.989 ／ 2.539–2.579 | 141.15 → 144.78 |
| legacy | 88.125 → 78.720 | 87.968–89.439 ／ 78.003–78.842 | 154.39 → 144.23 |
| soak | 61.331 → 53.217 | 60.840–62.346 ／ 52.842–53.351 | 106.57 → 110.88 |

採用42実行は全通知のDB確定まで完走し、OOM・投稿契約違反・計測欠落はなかった。通常通知の受付→完了p95は357.21→315.95 ms、soakは5.923→5.093秒。overlapの時間は意図的な送信保留を含む。normalの旧peakは初回100.93 MiBに対し残り2回は77.85–78.35 MiBであり、表の差を安定した21 MiB削減とは扱わない。全ケースでpeak memoryが低下したわけではない。

速度測定とは別にnormal / partsを各variantで1回ずつsampling profileした。推定累積割当はnormal 58.63→57.03 MiB、parts 2,526.34→2,219.95 MiB（12.1%減、1 partあたり1,154.90→1,014.84 KiB）。partsのDrizzle `sql.js` 内の割当は786.29→618.36 MiB（21.4%減）だった。累積割当は解放済みobjectを含み、live heap・RSS削減率ではない。各1回のsamplingであり、候補partsのtree外sample 1件・65,624 bytesは関数別集計へ混ぜていない。

送信を保留した独立のWeakRef診断では、旧実装が保持していたraw entry / payload / nested objectが新実装ではGCで回収された。9,778 bytes・5 partsの旧互換fixtureで、必要な配送済み番号は保持し、GC後に残り4 partsの本文SHA-256が一致した。GC後heapは両者とも約35.70 MiBで、この小fixtureから削減byte数は評価していない。強制GCを速度・容量測定の負荷中に挟んではいない。

[実SDKのオフライン試験](../tests/discord/shared/sendResultMessage.test.ts)では、cold / warm / full cache、220結果投稿、通常投稿205件、503 retry、429待機、遅延成功、清掃失敗を検証した。結果220件後の出欠message取得に伴う追加GETはwarm / fullとも旧1回→新0回。fullでは最初のSDK追加時に最古1件が除かれる挙動は残る。SDK内の3送信がアプリの45秒待機期限後も残るケースも確認し、論理slot数をSDK内の未完了数の上限とは扱っていない。

容量gateの標準17通知・932 partsはcgroup peak **146.71 MiB**で、必須目標192 MiBを達成した。別条件の「旧8 MiB通知＋8 MiB近傍に展開する異内容4受付」は旧185.96 MiBに対し新196.60 / 193.21 MiBだった。この条件のpeak改善は確認できず、192 MiB比較目標も未達である。両候補実行とも256 MiB内で完了し、旧通知は8,823 partsの計画と先頭1 partの確定までを検証した。上表の全件配送legacyとは分けて判断する。

`pnpm run ci` は112 files / 867 testsと型・lint・knip・build・docs・禁止patternが成功。実DB integrationは26 files / 131 tests、本番imageの非root・read-only検証も成功した。file-sizeは既存4件のadvisoryのみ。許可された実Discordチャンネルでも新しい送信関数による1投稿・cache解放・読み戻しを確認し、検証投稿を削除した。実Gateway、Neon、本番の長期性能は測定していない。

旧legacyの1実行は他のDB統合テストと重なったため除外し、DB負荷を分離した1実行で置き換えた（除外値118.677秒）。同時実行中に5秒期限を超えた統合テスト3件は、負荷分離後の全suite再実行で成功した。WeakRef診断の初回はMarkdown escapeを考慮しない検出条件が失敗し、診断を修正して旧・新を同条件で再確認した。いずれも失敗や除外を成功sampleへ混ぜていない。

比較は現在の計測器に旧・新imageを渡して再現できる。今回の一時スクリプト、raw profile、比較用source複製、専用DB・container・imageは検証後に回収し、恒久回帰テストと上記の集計を残す。以下の図表・集計JSONは最適化前の初回測定資料であり、今回の比較値とは区別する。

## 初回測定の結果と判断（最適化前）

**256 MiB・swapなし・1 CPUで、7ケース各3回の速度測定と、各ケース1回のCPU / heap profile採取を完了した。** 通常測定21実行で555通知・61,023 parts、profileを含む28実行で740通知・81,364 partsをDB確定まで処理した。warmupの48通知はこの集計から除外している。採用実行にOOM、未完了通知、予期しないHTTP失敗、Discord本文・mention・nonce契約違反、計測sampleの取りこぼしはなかった。

通常測定では、新規標準ケースのcgroup peak最大は **153.44 MiB**。192 MiB目標まで38.56 MiB、256 MiB上限まで102.56 MiBの余裕があった。旧8 MiB近傍の通知も **8,823投稿すべてを80.90〜111.17秒、最大148.51 MiBで完了**した。Fly設定は256 MiBのまま、アプリ本体・本番環境は変更していない。

主な改善候補はDB往復・query組み立てと、旧巨大通知の走査量である。legacyでは `begin` / `complete` 内が所要時間の96.31%を占めた。一方、100通知の連続負荷ではqueue待ちが増え、受付から完了までのp95は8.65秒だった。memory目標は合格だが、速度について合意済みのSLOはないため、合否を後付けせず実測値として報告する。

以下はlocal PostgreSQLと即時成功するDiscord代替送信での測定である。実Discord・Neon・Gatewayを含む本番性能の保証ではない。[集計JSON](./performance/notification-summary.json)には各実行・全percentile・heap space・CPU / allocation上位関数・rawのSHA-256を保存した。

## 処理速度

速度表はprofile実行を除いた3回の結果。所要時間・throughputは実行単位の中央値と最小〜最大、latencyは全実行の通知単位sampleをまとめたnearest-rankである。`part` はDiscordへの1投稿に相当する。

| ケース | 通知 / parts（1実行） | 全完了の秒数：中央値［範囲］ | parts / 秒：中央値［範囲］ |
|---|---:|---:|---:|
| normal | 20 / 20 | 3.04［3.03〜3.07］ | 6.59［6.52〜6.60］ |
| unicode | 20 / 1,140 | 10.81［10.69〜25.60］ | 105.46［44.54〜106.61］ |
| markdown | 20 / 1,440 | 13.05［12.42〜17.43］ | 110.34［82.61〜115.94］ |
| parts | 20 / 2,240 | 25.06［20.17〜32.10］ | 89.40［69.77〜111.07］ |
| legacy | 1 / 8,823 | 91.21［80.90〜111.17］ | 96.73［79.36〜109.06］ |
| soak | 100 / 6,450 | 70.04［62.39〜93.79］ | 92.09［68.77〜103.39］ |

| ケース | HTTP 202：p50 / p95 / p99（ms） | 受付→初回送信：p50 / p95（秒） | 受付→DB確定：p50 / p95 / p99（秒） |
|---|---:|---:|---:|
| normal | 15.15 / 31.23 / 49.43 | 0.291 / 0.305 | 0.301 / 0.314 / 0.351 |
| unicode | 45.69 / 105.67 / 247.44 | 0.293 / 0.336 | 1.073 / 3.854 / 4.121 |
| markdown | 37.91 / 84.84 / 101.95 | 0.299 / 0.315 | 1.272 / 1.831 / 3.553 |
| parts | 59.83 / 89.24 / 124.00 | 0.298 / 0.329 | 2.178 / 4.840 / 7.373 |
| soak | 48.31 / 106.99 / 138.21 | 3.076 / 6.972 | 4.119 / 8.645 / 9.729 |

normal〜partsは各60通知、soakは300通知の集計。legacyはHTTP受付を通らないためこの表へ混ぜない。legacyのclaim→初回送信は0.710〜0.897秒、claim→完了は80.52〜110.76秒だった。

![通知latencyと各実行のthroughput](./performance/latency-throughput.png)

初回測定当時のnormalは2通知ごとに完了を待つため、schedulerの250 ms wake debounceが繰り返し入った。6.59 parts/秒をサーバーの最大処理能力と解釈しない。soakは10件ずつ受け付けるためqueueができ、claim→完了p95の2.126秒に対して受付→完了p95が8.645秒となった。これらのpercentileの差を、同一通知のqueue時間として引き算はしない。

Unicodeの全完了時間には2.39倍、partsには1.59倍の最速・最遅差がある。Unicodeの初回はCPU 11.99秒、後続は4.67 / 5.10秒で、CPU throttleも1.44秒対0.06 / 0.08秒だった。throttle・GCだけで差全体を説明できず、JIT・host / DB状態等の要因は切り分けていない。最速値だけで性能を評価しない。

### 受付・配送が重なるケース

overlapは2配送を保留中に512 KiB本文を2本受け付け、さらに旧容量への数値展開を伴う競合4件と過負荷1件を実行した。通常測定3回で期待した409が12件、503が3件、profileも含めると409が16件、503が4件となった。

409の応答は90.73〜526.94 ms、503は1.21〜3.99 ms。配送の意図的保留673〜892 msを含めて4通知・228 partsは2.55〜2.94秒で完了した。保留の影響があるため通常のlatency / throughput比較表には含めない。

## Memory・GC・event loop

下表は通常測定3回。cgroup・heapUsed・externalは3回の最大値、post-GCは範囲で、単位はMiB。各列のpeak時刻は同一とは限らない。

| ケース | cgroup peak | heapUsed peak | external peak | 終了後GCのheap | warmからのheap増分 |
|---|---:|---:|---:|---:|---:|
| normal | 78.75 | 47.96 | 6.47 | 43.24〜43.25 | 1.66〜1.69 |
| unicode | 98.66 | 57.10 | 8.15 | 43.22〜43.50 | 1.61〜1.94 |
| markdown | 100.73 | 58.39 | 7.56 | 43.52〜43.61 | 1.96〜2.04 |
| parts | 100.45 | 57.09 | 7.90 | 43.42〜44.03 | 1.86〜2.46 |
| overlap | 153.44 | 52.85 | 65.87 | 41.95〜41.96 | 0.39〜0.39 |
| legacy | 148.51 | 89.25 | 36.41 | 44.93〜45.04 | 5.30〜5.43 |
| soak | 108.96 | 61.00 | 8.69 | 45.98〜46.10 | 4.41〜4.52 |

![各ケースのmemory時系列](./performance/memory.png)

図は各ケースの所要時間が中央値の実行。50 ms sampleを最大500個のbucket最大値へ集約しており、表の3実行最大値とは異なる。cgroup高水位はkernelから別途取得するので、50 msより短いpeakも合否に反映される。

overlapではheapUsedよりexternalの増加が目立ち、V8 heapだけを監視すると余裕を過大評価する。通常の新規配送は最大2件・payload合計523,370 bytes、旧巨大通知は単独8,382,648 bytesという制御が維持された。soakのold spaceはwarm約33.87 MiBからGC後36.12〜36.34 MiB、large object spaceは1.75 MiBで変わらなかった。

soak終了時には12,900件のpart操作記録、約13,260件の操作時間、1,255〜1,875件のmemory sample、約9,550件のGC記録を計測器自身が保持している。legacyも17,646件のpart記録等を保持する。post-GC増分にはこれらとJIT等が含まれるため、この増分をそのままアプリのleak量と呼ばない。逆に約1分〜1分半のsoakだけで長期leakの不存在も証明しない。

| ケース | CPU使用率：1 core比 | 自然GC合計（秒） | GC最大pause（ms） | event-loop p99（ms） | event-loop最大（ms） |
|---|---:|---:|---:|---:|---:|
| normal | 17.9〜19.3% | 0.033〜0.034 | 2.84 | 11.61〜13.07 | 29.52 |
| unicode | 43.2〜47.7% | 0.399〜0.950 | 20.69 | 12.76〜14.23 | 65.73 |
| markdown | 48.0〜48.4% | 0.516〜0.762 | 16.18 | 12.99〜13.27 | 39.16 |
| parts | 36.1〜45.5% | 0.805〜0.992 | 11.46 | 12.59〜13.00 | 76.02 |
| overlap | 56.3〜59.4% | 0.100〜0.109 | 4.07 | 29.16〜34.24 | 91.29 |
| legacy | 34.8〜37.8% | 2.708〜3.627 | 106.45 | 10.97〜11.46 | 354.16 |
| soak | 43.1〜48.5% | 2.761〜3.527 | 59.13 | 12.60〜13.18 | 81.00 |

GC最大とevent-loop最大は3回の最大値。自然GC回数はlegacy 10,584〜10,890回、soak 9,523〜9,642回だった。legacyはp99が小さくても単発354 msのevent-loop遅延があり、p99だけでは重い同期区間を見落とす。event-loop利用率はlegacy約27〜28%、soak約33〜35%で、CPUを常時使い切る状態ではなかった。

## CPU・heap profile

各ケースの別実行でCPU・allocation profileを採取した。以下の累積割当は、解放済みobjectを含むtree selfSizeの推定総量であり、同時に保持している量ではない。

| ケース | 推定累積割当（GiB） | profile負荷中cgroup peak（MiB） | profile出力後cgroup peak（MiB） |
|---|---:|---:|---:|
| normal | 0.058 | 93.29 | 95.03 |
| unicode | 1.255 | 108.78 | 115.74 |
| markdown | 1.644 | 114.42 | 126.70 |
| parts | 2.498 | 112.58 | 130.88 |
| overlap | 0.280 | 156.38 | 156.38 |
| legacy | 8.364 | 168.38 | 216.28 |
| soak | 7.046 | 127.69 | 171.50 |

legacyのprofile JSON出力まで含めると216.28 MiBまで上昇した。256 MiBでは完了したが192 MiBの通常処理目標を超える。これは計測終了後にprofile objectとJSONを生成する診断処理であり、通常処理のpeakとは分けて扱う。profileを本番で常時採取する設計は、この結果からは推奨しない。

![CPUとallocationの主な関数](./performance/profile-hotspots.png)

heapの上位はDrizzleの `sql`、`buildQueryFromSourceParams`、`sql.js:83:36` のcallbackだった。この3箇所のexclusive割当はpartsで27.39%、legacyで31.69%、soakで28.85%。legacyでは文字列 `replace` も10.47%を占めた。大量の投稿ごとのquery構築・escapingで短命objectを繰り返し作る形が観測され、入力payloadだけを小さくする以外の最適化余地がある。

CPUのidle sampleはlegacy 75.99%、soak 72.06%。非idle sample内ではGCがそれぞれ19.17 / 19.89%、`writeBuffer` が9.76 / 8.60%を占めた。overlapはcrypto `update` が7.47%、`hashJsonbText` が4.06%で、旧identity照合に伴うhash処理も現れた。CPU profileはsample時間の分類であり、`process.cpuUsage`のCPU秒やDB待ちの厳密な内訳ではない。関数はscript・URL・行・列まで区別し、callerを重複加算しないexclusive値を使う。

profileには計測器と停止処理の負荷も含まれる。V8のheap sampling停止は内部で強制GCするため、CPU末尾のheap停止・出力区間（約22〜162 ms）のGCを自然GCへ混ぜて解釈しない。上の自然GC表と速度表は、この停止処理の前に固定した値である。[Node 24.21.0のInspector実装](https://github.com/nodejs/node/blob/v24.21.0/deps/v8/src/inspector/v8-heap-profiler-agent-impl.cc#L499-L589)

markdownのheap profileでは26,735 sample中、末尾の1 sample（推定65,640 bytes、sample総量の0.00372%）がtree内に対応nodeを持たなかった。V8はtree変換中の割当もsampleし、その後sample一覧を取得するため、export中の新規nodeがtreeへ入らなかった可能性が高い。内部traceを採っていないため原因は推定とし、rawを改変せず、集計の `unattributedSamples` / `unattributedSampleBytes` に明示した。treeとsample総量は補正・整数丸めの単位も異なるため、差分を足して補正したり、特定関数へ割り当てたりしていない。[V8 sampling実装](https://github.com/nodejs/node/blob/v24.21.0/deps/v8/src/profiler/sampling-heap-profiler.cc#L219-L295)

profile実行はbaselineより速いもの・遅いものがあった。単発の別実行と3回の中央値の比率は集計に残したが、環境のばらつきも含むのでprofiler overheadの因果推定には使わない。

## 測定条件

2026-09-29、Summit の本番 image に probe を注入し、実際の HTTP receiver・入力検証・PostgreSQL 永続化・dispatcher・renderer を実行した。Bot の通常 entrypoint と Gateway login は起動しない。Discord channel 取得・送信は本文・mention・nonceを検査して即時成功する代替、readiness は受付可能、logger は警告・エラーの計数に置き換えている。結果の「配送完了」は各 part の DB `DELIVERED` 確定までを指す。実 Discord REST の待ち時間・rate limit・Gateway cache・本番ログ転送は含まない。

| 項目 | 条件 |
|---|---|
| アプリ本体 | commit `4ebe5e3`。測定用 script・文書以外のアプリ実装は変更していない |
| Runtime | Node.js 24.21.0 / V8 13.6.233.17-node.53、Debian / Linux arm64、非 root の本番依存 image |
| Image識別子（`docker image inspect`） | `sha256:6472895b5653465f59f3fb22c01ac658d34cd1e7a909e8a4666b0c6cd18787cf` |
| アプリ資源 | memory 256 MiB、swap なし、CPU quota 1 |
| DB | local PostgreSQL 18.4、別コンテナ。各実行に migration 済みの専用 DB を作成し終了後回収 |
| DB schema | momo-db commit `87d18c6159e6cb046d6bdc13e9802cc0d93df8a1` |
| ホスト | Apple M3 Pro / RAM 18 GiB。Docker VM は 11 CPU / 約 7.65 GiB |
| 反復 | 各ケースを新規 container・DB で3回。別途、同じ負荷で profile を1回採取 |
| 負荷生成 | host 側で fixture 生成・HTTP 送信。アプリ cgroup の使用量に host / DB の memory は含まない |

CPU quota 1 は CPU 時間の制限であり、Fly の shared CPU の競合・credit・ネットワーク環境の再現ではない。PostgreSQL はアプリの memory / CPU quota 外にある。cgroupとFly VM全体ではOS等のmemory計上範囲も異なる。Fly / Neon / Discord の本番 p95・p99 や本番 throughput へ数値を転用しない。基準測定にもwrapperと50 ms計測の負荷が含まれ、計測器を完全に外した対照実験ではない。

## ワークロードと計測境界

新規入力の byte 数は PostgreSQL `jsonb::text` の UTF-8 byte、本文長は Discord の UTF-16 単位で検査した。文字列長、件数、canonical byte、URL 長、投稿数は別の制約であり、ひとつの fixture がすべての最大を同時に満たすわけではない。

| ケース | 1実行の内容 | 狙い |
|---|---|---|
| normal | 分析10件＋OCR10件。分析は1試合・1シーズン | 小規模通知の比較基準。ID は200文字の容量 fixture を使うため、実運用の典型的な分布とは異なる |
| unicode | 50試合・16シーズン、canonical 256 KiB近傍の分析20件 | UTF-8 / UTF-16 と canonical 容量の境界 |
| markdown | 名称256・表示名32・メモ150文字を `*` で埋めた分析20件 | escaping による本文展開 |
| parts | 合法な112投稿の分析20件。match ID は200 UTF-16、各 match URL は1,800文字 | 投稿数・DB 確定回数が多い新規入力。極端な数値・ID を使う敵対的 fixture |
| overlap | 大本文4件を配送。2配送保留中に512 KiB本文を2受付、さらに旧容量へ数値展開する4競合受付と過負荷1受付 | 受付と配送の資源重複、409 / 503 の応答 |
| legacy | 旧8 MiB近傍の通知1件、8,823投稿すべてを確定 | 既受理データの後方互換と長い配送 |
| soak | Unicode と Markdown を各5件ずつ投入する round を10回、計100件 | 継続した queue・allocation・自然GC・終了後の残存量 |
| mixed | 長い分析2件を先頭送信で保留し、後着OCR1件を受け付けてから解放。10 roundで30通知 | 長文2件によるslot占有と後着OCRの待ち時間 |
| stream | 分析2件を保留し、OCRの初回受付後に解放。以後25 ms間隔で計20 OCR、各送信に5 msの模擬遅延 | OCRの継続到着中にも分析が進むか。到着終了時の分析送信数を記録 |
| legacyqueue | 小さいOCRの送信保留中に旧8 MiB分析、後続OCRを投入。旧分析8,823 partsも全件確定 | 最古の大容量通知が追い越されず、単独配送を保つこと |

`parts` は [fixture](../scripts/perf/notificationPerformance.parts.ts) を new-admission validator と renderer に通して確認した。128投稿は安全上限であり、112が全制約下の数学的な最大であるとも、128を実測したとも主張しない。

normal / unicode / markdown / parts の各 round は2並列で受け付け、その2件の配送完了後に次 round へ進む。soak は2並列で10件を受け付けてから全完了を待つ。追加した公平配送ケースの到着・保留条件は上表のとおり。legacy 以外は分析・OCR を各1件配送して warmup し、GC 後に counters と計測窓をリセットする。legacy は既存 DB 行から開始するため、初回 claim を含む cold な経路を測る。

測定中の強制GCは行わない。全処理と drain が完了した時点で負荷の metrics を固定し、その後で profiler 停止・診断GC・profile JSON 生成を行う。診断GC後の heap と serialization 後の cgroup peak は `finalization` に分離する。

| 指標 | 意味 |
|---|---|
| HTTP latency | host の request 開始から HTTP response body の終了まで。202は永続受付の完了であり配送完了ではない |
| receipt → first send / complete | server の receive port 入口から初回 `send` 開始 / 最終 part の DB 確定まで。queue 待ちを含む |
| claim → first send / complete | 初回DB claim の応答から初回 `send` / 最終確定まで。譲渡後の再待機も含む。legacy の比較はこちらを使用 |
| `queueWaitMs` | 受付commitのport応答から初回claimのport応答まで。claimのDB処理・通信も含み、純粋なqueue待ちではない |
| `dispatch.wakeToClaimStart` / `slotReleaseToClaimStart` | 最初の未消化wake / 配送終了wakeから次のclaim command開始まで。枠待ちを含み、timerの遅延だけを測る値ではない |
| `receive`, `claim`, `plan`, `begin`, `complete` | 実 repository port の wall time。SQL・lock・network 待ちを含む。`plan` は part 行を DB に保存する操作であり純粋 renderer の計画時間ではない |
| CPU | `process.cpuUsage()` の user / system。CPU使用率は1 CPUに対する割合 |
| event-loop delay | 10 ms 間隔 histogram。値は nanoseconds から ms へ換算し、計測間隔由来の約10 msも含む |
| GC | PerformanceObserver の自然GCの回数・合計・最大。負荷終了後の診断GCは含めない |
| memory | 50 ms間隔とcontrol呼出時にRSS・heapUsed・heapTotal・external・arrayBuffers・cgroupを採取 |
| `maxRss`, `cgroupPeak` | container 起動後の高水位。warmup も含む。RSSとcgroupは計上対象が異なり、足し合わせない |
| post-GC heap | 終了後に残る V8 heap。計測用のduration・part・memory配列も含むため、増分だけでアプリのleakを判定しない |

overlap の `receive` / `receiveTotal` は409になる4試行も含む。成功受付だけのHTTP統計と混同しない。heap増分の比較元 `warm` は warmup後のGCから `/reset` と計測器初期化を経たcheckpointであり、厳密に同条件のGC直後同士を比較する値ではない。

profile は速度測定とは別実行にする。CPU は1 ms sampling、heap は平均64 KiB samplingで、major / minor GCにより解放された object の割当も含める。heap profileの byte は累積割当の推定であり、live object量・RSS・memory peakではない。`arrayBuffers` は `external` の一部なので両者を合算しない。[Node memory / CPU](https://nodejs.org/docs/latest-v24.x/api/process.html)、[perf_hooks](https://nodejs.org/docs/latest-v24.x/api/perf_hooks.html)、[DevTools Protocol](https://github.com/ChromeDevTools/devtools-protocol/blob/master/json/js_protocol.json)

heap sampling停止をCPU停止より先に行い、CPU profile exportの割当がheapに混ざるのを防いだ。CPU末尾にはheap exportの短い時間が含まれるため、両stop時刻を記録している。profile実行のpost-GC heapにはexport済みprofile objectも含まれ、残存heapの判定には使わない。full heap snapshotは採っていない。同期処理と約2倍のheap memoryを必要とするため、256 MiBの通常動作を測る目的にはsamplingを使用した。[Node V8 heap snapshot](https://nodejs.org/docs/latest-v24.x/api/v8.html#v8getheapsnapshotoptions)

## DB 操作の時間と走査量

legacy全配送は3回とも8,823 partsを確定し、111.171 / 91.208 / 80.902秒だった。`begin` と `complete` の合計wall timeは107.303 / 87.564 / 77.965秒で、全時間の96.52 / 96.00 / 96.37%（合計時間で重み付けすると96.31%）を占めた。単独配送なのでこの2操作は互いに重複しない。描画以外のDB port command内が主な所要時間であり、driver・通信往復・lock待ち・呼び出し中のGCも含む。[配送処理](../src/db/repositories/notifications.delivery.ts)と[transaction境界](../src/db/repositories/notifications.storage.ts)から、正常経路は1 partあたり20 SQL・2 transactions、8,823 partsではbegin / completeだけで176,460 SQL・17,646 transactionsとなる。claim・plan・heartbeat等は別に加わる。

先頭10%と末尾10%のbegin＋complete平均は、7.771→17.057 ms、8.148→13.829 ms、9.080→8.038 msだった。後半の悪化は全実行で再現していないため、集約値だけで一様な劣化や特定の原因を断定しない。

![part位置別のDB操作時間](./performance/database-part-latency.png)

[専用のEXPLAIN診断](../scripts/perf/notificationPerformance.explain.ts)で、実配送の `begin` にある「前の未完了part」、`complete` にある「残りの未完了part」を探す2つのSELECTを測った。112 / 8,823 partsそれぞれの先頭・中間・末尾を独立した静的fixtureで再現し、各SELECTにつきwarmup 1回・採用3回、計36 plansを集計した。[計画と集計データ](./performance/query-plans.json)

| 8,823 parts の位置 | begin中央値 | complete中央値 | beginの走査 | completeの走査 |
|---|---:|---:|---|---|
| 先頭 | 0.006 ms | 0.006 ms | PK Index Scan、除外0行 | Seq Scan、除外0行 |
| 中間（partNo 4,411） | 0.307 ms | 0.148 ms | Seq Scan、除外8,823行 | Seq Scan、除外4,411行 |
| 末尾（partNo 8,822） | 0.340 ms | 0.303 ms | Seq Scan、除外8,823行 | Seq Scan、除外8,823行 |

112 partsの両SELECTは全位置でSeq Scan、中央値0.006〜0.010 msだった。part表には `(notification_id, part_no)` のPKがあり、未完了statusに絞るindexはない。大きい通知では配送後半も終了済みpartの走査が発生することを確認した。これを毎part繰り返すため、大容量通知の走査総量が二次的に増えるリスクがある。ただし、静的fixtureでのSELECT単体の時間から実配送全体の遅延原因を決めつけない。

測定は専用DB内の、通知配送に使わないSQL診断用parentとpartsだけを対象にしている。更新履歴・dead tuple・autovacuum・大量の他通知・advisory lock競合は再現していない。`ANALYZE`とwarmup後の温かいcacheであり、cold cacheの数値ではない。`TIMING OFF`でもstatement全体のExecution Timeは採取される一方、clientとのnetwork往復は含まれない。BUFFERSはrootの延べ参照を使い、子nodeの値を重複加算していない。[PostgreSQL 18 EXPLAIN](https://www.postgresql.org/docs/18/sql-explain.html)、[計画の解釈](https://www.postgresql.org/docs/18/using-explain.html)

## 初回測定時の改善候補

| 優先 | 観測根拠 | 次の改善・確認 |
|---|---|---|
| 1 | legacy所要時間の96.31%がbegin / complete内、1 partに20 SQL・2 transactions。query構築の割当も多い | claim fencing・取消・順序・crash recoveryの契約を維持したまま、重複照会とDB往復を減らす設計を比較する。近接DBだけでなく実際のNeon RTTを含めて再測定 |
| 2 | 8,823 partsで未完了検索の全件走査、112 partsではSELECT中央値0.01 ms以下 | momo-db所有のschemaとして未完了partに絞るpartial index等を検討する。既存索引・更新コスト・本番分布でEXPLAIN比較し、速度改善量を実測してから採否を決める |
| 3 | 旧巨大通知の文字列割当と最大354 msのevent-loop遅延、overlapのexternal peak65.87 MiB | 旧互換のrenderer / hash処理を個別に測り、不要な再生成・buffer複製を減らす候補を検証する。hashの同一性や投稿境界を変えない |
| 4 | soakの初回送信p95 6.97秒、完了p95 8.65秒。実Discordは未測定 | 本番のqueue最古age・受付→送信・DB transaction・REST rate limit・event-loop最大・cgroup / RSS / externalを観測し、業務上のlatency目標を決める |

この初回測定を理由に受付上限・並列数を増やす根拠はない。上記の2026-10-02比較でSQL往復と不要参照を減らした。index変更や配送のtransaction削減は実装せず、標準制限とFly 256 MiBを維持している。

## 計測器と変更の検証

| 検証 | 結果 |
|---|---|
| 本番image build / `verify:runtime-image` | 成功。非root・read-only code・本番依存・共有schema importを確認 |
| 新規の性能測定 | 21 baseline＋7 profileを完走。各実行のDB確定件数・投稿契約・予期した拒否・計測欠落0を確認 |
| EXPLAIN | 12条件の採用36 plansを取得。専用DBを回収 |
| `pnpm run ci` | 成功。111 files / 856 tests、型・lint・knip・build・docs・禁止patternを通過 |
| 既存の容量gateを最終再実行 | 成功。標準17通知 / 932 parts、cgroup peak148.98 MiB。旧巨大通知＋4競合受付は188.83 MiB |
| `verify:docs --include docs/performance.md` / `git diff --check` | 成功 |

既存容量gateの旧ケースは計画8,823 partsの先頭1 partだけを送り、巨大通知と競合受付の重複時のmemoryを見る。全件速度を測った本書のlegacyとは別条件であり、上の188.83 MiBも別の結果として残す。file-size検査には変更対象外の4ファイルの既存advisoryがあるが、失敗はない。アプリ・schema契約の変更がないため既存integration suite全体は再実行せず、追加した負荷・SQL診断は実DBで検証した。

計測器には失敗を成功成果物へ混ぜない検査、rawの上書き防止、秘匿値を除く診断、中断時の専用DB / container回収を加えた。CPU重み付き集計、関数位置の分離、heap子nodeの二重計上防止、未帰属sampleの可視化、合法112投稿fixture、引数拒否・中断cleanupをtestで確認している。

## 再現と成果物

[計測器](../scripts/perf/notificationPerformance.ts) は `TEST_DATABASE_URL` に local DB を要求し、固有名の DB / container だけを作成・回収する。既存の DB / volume を reset しない。出力先は新規 directory に限定し、既存結果を上書きしない。token・接続URL・通知本文を artifact に保存しない。

```sh
# 親 directory を context として本番 image を作る
docker build --file summit/Dockerfile --tag summit-runtime-standard-check .

# summit directory。公開fixture用のlocal接続情報を明示する
TEST_DATABASE_URL=postgres://summit:summit@127.0.0.1:5433/summit \
  pnpm profile:notifications summit-runtime-standard-check \
  --output artifacts/notification-performance/new-run \
  --scenario all --repetitions 3 --rounds 10 --profile

node scripts/perf/notificationPerformance.analyze.ts \
  artifacts/notification-performance/new-run /tmp/notification-summary.json
```

pnpm が script 追加に伴う依存再検証を要求するときは、[開発規約](./dev-rule.md)に従い、その command だけ `pnpm_config_verify_deps_before_run=false` を付けられる。`--scenario normal|unicode|markdown|parts|overlap|legacy|soak|mixed|stream|legacyqueue` で個別実行できる。`--profile` を外すと速度計測のみ、`--profile-only` は速度の再測定を省略してprofileだけを採る。

`--database-diagnostics` はDBのcommand別statement数・transaction数・時間を追加する独立実行で、profileとの併用は拒否する。速度baselineへ混ぜない。Drizzleのstatementは実測、driverが出す成功transactionのBEGIN / COMMITは2件として別欄に推計する。transaction入口はpool取得・BEGIN・isolation設定を含み、gate呼出しは通信・server待ちを含む。gate保持時間は応答後からcommit / rollback完了までであり、server内の正確なlock保持時間ではない。SQL本文・引数・接続情報は記録しない。この診断だけではSQLのserver実行時間・network RTT・純粋なlock待ちへ分解できない。

HTTP接続の比較は引数なしの `pnpm profile:notification-http` で行う。loopback・DB代替・TLSなし・同時1要求で、各modeのwarmup20件を除き、500要求×各5反復のcold / reuseを交互に測る。両modeとも候補receiverを使い、coldだけclientがcloseを指定する。同一OCR identityの初回は202、残り499件はduplicateの200となる。再利用統計は100要求ごとの新接続を除く2,475 sampleで、接続確立は別集計する。request時間にはHTTP・fake DB処理も含み、純TCP時間ではない。実DB・Discordを含まず、本番のproducerやネットワークの改善量へ換算しない。

SQL診断は同じlocal `TEST_DATABASE_URL` を明示し、`node scripts/perf/notificationPerformance.explain.ts --output <new-directory>` で実行する。性能測定とは同時実行しない。

raw artifact は `artifacts/notification-performance/` 以下で Git 管理外とし、manifest に image digest・source / schema commit・lockfile hash・runtime・Docker / DB 条件を残す。各ケースの JSON に全 latency sample・memory時系列・partNo順のDB操作時間を保存する。`.cpuprofile` / `.heapprofile` は Chrome DevTools の該当 profiler へ読み込める標準形式。集計は [analyzer](../scripts/perf/notificationPerformance.analyze.ts) で行い、raw artifact のSHA-256も記録する。

今回の採用rawは `artifacts/notification-performance/report-20260929/`、SQL rawは `artifacts/notification-performance/explain-20260929/`。図のPNG / SVGと集計JSONは本書とともにGit管理し、大きい生profileは管理外に置く。図はPython / Matplotlib 3.11.2の静的描画で生成し、描画recipeはraw成果物に添付する。

初回legacy試行は負荷終了後の巨大な計測レスポンスが途中で切れ、結果を取得できなかった。probeがHTTP `end()` 直後にserverを閉じていた問題を、4 MiBレスポンスの再現で特定し、flush完了を待つよう修正した。この失敗試行は集計に含めず、legacyを3回やり直した。先に完了していた他5ケース15実行は負荷・計測窓が変わらないため採用し、source directory・SHA-256・除外理由を統合manifestへ残した。測定の成功判定を緩めた変更ではない。

percentileは3実行の生観測をまとめた nearest-rank。per-run p95の平均ではない。event-loop histogramは元sampleを保持しないため、3実行を合成せず各実行の値を比較する。3反復・有限件数の結果に統計的SLAを付与しない。とくに100件未満のp99は最大値に近い参考値である。overlapの意図的保留を含むlatency・throughputは通常負荷の速度表から分ける。

外部停止、Discordの実送信、Neonへの往復、長期Gateway cache、出欠処理との同時最大負荷、日単位のmemory断片化は未測定。本書の範囲で完走しても、これらの未測定条件や長期のleak不存在を証明するものではない。
