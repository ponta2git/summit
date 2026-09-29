# 通知処理のパフォーマンスレポート

通知の容量・処理速度・CPU・heap を判断するための測定記録。通知入力、配送処理、DB クエリ、Node / image、CPU / memory 条件を変えたら再測定する。上限の契約は [品質評価](./quality-assurance.md#実行メモリの容量契約) と [notification config](../src/notifications/config.ts) が所有し、本書は測定条件・結果・評価限界を所有する。

## 結果と判断

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

normalは2通知ごとに完了を待つため、[scheduler](../src/scheduler/resultNotifications.ts)の250 ms wake debounceが繰り返し入る。6.59 parts/秒をサーバーの最大処理能力と解釈しない。soakは10件ずつ受け付けるためqueueができ、claim→完了p95の2.126秒に対して受付→完了p95が8.645秒となった。これらのpercentileの差を、同一通知のqueue時間として引き算はしない。

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

`parts` は [fixture](../scripts/perf/notificationPerformance.parts.ts) を new-admission validator と renderer に通して確認した。128投稿は安全上限であり、112が全制約下の数学的な最大であるとも、128を実測したとも主張しない。

各 round の受付は2並列。通常ケースは2件の配送完了を待って次 round へ進み、soak は10件を受け付けてから全完了を待つ。legacy 以外は分析・OCR を各1件配送して warmup し、GC 後に counters と計測窓をリセットする。legacy は既存 DB 行から開始するため、初回 claim を含む cold な経路を測る。

測定中の強制GCは行わない。全処理と drain が完了した時点で負荷の metrics を固定し、その後で profiler 停止・診断GC・profile JSON 生成を行う。診断GC後の heap と serialization 後の cgroup peak は `finalization` に分離する。

| 指標 | 意味 |
|---|---|
| HTTP latency | host の request 開始から HTTP response body の終了まで。202は永続受付の完了であり配送完了ではない |
| receipt → first send / complete | server の receive port 入口から初回 `send` 開始 / 最終 part の DB 確定まで。queue 待ちを含む |
| claim → first send / complete | DB claim の応答から初回 `send` / 最終確定まで。legacy の比較はこちらを使用 |
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

## 改善の優先順位

| 優先 | 観測根拠 | 次の改善・確認 |
|---|---|---|
| 1 | legacy所要時間の96.31%がbegin / complete内、1 partに20 SQL・2 transactions。query構築の割当も多い | claim fencing・取消・順序・crash recoveryの契約を維持したまま、重複照会とDB往復を減らす設計を比較する。近接DBだけでなく実際のNeon RTTを含めて再測定 |
| 2 | 8,823 partsで未完了検索の全件走査、112 partsではSELECT中央値0.01 ms以下 | momo-db所有のschemaとして未完了partに絞るpartial index等を検討する。既存索引・更新コスト・本番分布でEXPLAIN比較し、速度改善量を実測してから採否を決める |
| 3 | 旧巨大通知の文字列割当と最大354 msのevent-loop遅延、overlapのexternal peak65.87 MiB | 旧互換のrenderer / hash処理を個別に測り、不要な再生成・buffer複製を減らす候補を検証する。hashの同一性や投稿境界を変えない |
| 4 | soakの初回送信p95 6.97秒、完了p95 8.65秒。実Discordは未測定 | 本番のqueue最古age・受付→送信・DB transaction・REST rate limit・event-loop最大・cgroup / RSS / externalを観測し、業務上のlatency目標を決める |

この測定を理由に受付上限・並列数を増やす根拠はない。現在の標準制限とFly 256 MiBを維持し、次の性能変更は上記の同じfixture・3反復・互換性検証で比較する。index変更や配送のtransaction削減は本レポート作成の範囲では実装していない。

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

pnpm が script 追加に伴う依存再検証を要求するときは、[開発規約](./dev-rule.md)に従い、その command だけ `pnpm_config_verify_deps_before_run=false` を付けられる。`--scenario normal|unicode|markdown|parts|overlap|legacy|soak` で個別実行できる。`--profile` を外すと速度計測のみ、`--profile-only` は速度の再測定を省略してprofileだけを採る。

SQL診断は同じlocal `TEST_DATABASE_URL` を明示し、`node scripts/perf/notificationPerformance.explain.ts --output <new-directory>` で実行する。性能測定とは同時実行しない。

raw artifact は `artifacts/notification-performance/` 以下で Git 管理外とし、manifest に image digest・source / schema commit・lockfile hash・runtime・Docker / DB 条件を残す。各ケースの JSON に全 latency sample・memory時系列・partNo順のDB操作時間を保存する。`.cpuprofile` / `.heapprofile` は Chrome DevTools の該当 profiler へ読み込める標準形式。集計は [analyzer](../scripts/perf/notificationPerformance.analyze.ts) で行い、raw artifact のSHA-256も記録する。

今回の採用rawは `artifacts/notification-performance/report-20260929/`、SQL rawは `artifacts/notification-performance/explain-20260929/`。図のPNG / SVGと集計JSONは本書とともにGit管理し、大きい生profileは管理外に置く。図はPython / Matplotlib 3.11.2の静的描画で生成し、描画recipeはraw成果物に添付する。

初回legacy試行は負荷終了後の巨大な計測レスポンスが途中で切れ、結果を取得できなかった。probeがHTTP `end()` 直後にserverを閉じていた問題を、4 MiBレスポンスの再現で特定し、flush完了を待つよう修正した。この失敗試行は集計に含めず、legacyを3回やり直した。先に完了していた他5ケース15実行は負荷・計測窓が変わらないため採用し、source directory・SHA-256・除外理由を統合manifestへ残した。測定の成功判定を緩めた変更ではない。

percentileは3実行の生観測をまとめた nearest-rank。per-run p95の平均ではない。event-loop histogramは元sampleを保持しないため、3実行を合成せず各実行の値を比較する。3反復・有限件数の結果に統計的SLAを付与しない。とくに100件未満のp99は最大値に近い参考値である。overlapの意図的保留を含むlatency・throughputは通常負荷の速度表から分ける。

外部停止、Discordの実送信、Neonへの往復、長期Gateway cache、出欠処理との同時最大負荷、日単位のmemory断片化は未測定。本書の範囲で完走しても、これらの未測定条件や長期のleak不存在を証明するものではない。
