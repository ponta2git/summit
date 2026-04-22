# 0036. Reconnect replay on shardReady

- Status: accepted
- Date: 2026-04-21
- Deciders: maintainer (solo)

## Context

Fly.io の単一インスタンス運用 + node-cron の毎分 tick 設計 (ADR-0024, ADR-0033) では、
Discord WebSocket が一時的に切断している間も cron tick は JST の現在時刻に従って発火する。
このとき Discord API を叩こうとする副作用 (ask 初回投稿 / settle 後の再描画 / 開催決定メッセージ /
outbox worker の配送など) は一時的に失敗する。

ADR-0033 で startup reconciler を導入し、プロセス再起動時には DB を正本として invariant を収束させる
仕組みが入った。しかし「プロセスは生きていて Discord だけ再接続した」場合は startup reconciler は
呼ばれず、disconnect 中に発火した tick の Discord 副作用が孤立する可能性が残っていた。

具体例:
- 金曜 08:00 の ask tick が投稿直前で Discord 切断 → session は ASKING/askMessageId=NULL 状態で
  放置される (N1 的状況だが startup reconciler は呼ばれない)。
- 金曜 21:30 の settle tick が途中で切断 → CANCELLED 中間停滞や outbox claim stuck を招く。

また、短時間に shardReady が多発するフラップ (ネットワークノイズ) で replay を多重起動すると、
reconciler 内の active probe や CAS が重複して走り、Discord API rate limit を無駄に消費する。

セッション中の rubber-duck は以下 3 点を指摘した:
1. 単純な時刻 debounce だけでは並行実行を防げない (Promise-based in-flight lock が必要)。
2. replay 中は dispatcher が interaction を処理しないよう `AppReadyState` を not-ready にすべき
   (ADR-0033 の startup ready gating と整合させる)。
3. reconnect 時に startup の active probe (D': 全非終端 session に `channel.messages.fetch(...)`)
   を走らせると毎再接続で Discord fetch を消費する。reconnect では抑制し、scheduler tick の
   opportunistic 再描画に委ねる方が安全。

## Decision

`client.on("shardReady", ...)` ハンドラで reconnect-replay を起動する。次の 3 つの安全装置を併用する:

1. **Startup gate**: `startupCompleted === false` の間は no-op。初回 ready は通常の startup パスで
   処理され、replay 扱いしない。
2. **In-flight Promise lock**: `replayInFlight: Promise<void> | undefined` が非 undefined の間は
   新規 replay を起動しない。完了時に markAppReady し lock を解放する。
3. **Time debounce**: 直近の成功 replay から `RECONNECT_REPLAY_DEBOUNCE_MS` (= 30 秒) 以内は
   replay を skip して markAppReady するのみ。flappy 再接続で reconciler が連打されることを防ぐ。

replay 中は `markAppNotReady("replaying")` を呼び、dispatcher 経由の interaction は ephemeral で
rejection される (ADR-0033 の startup gating 機構を再利用)。

reconciler は新設の `scope: "reconnect"` で呼び出す。`"startup"` と同じ invariant (A: stranded CANCELLED,
B: missing ask session, C: missing ask message, E: stale reminder claim, F: outbox claim reclaim) を
実行し、**startup 限定の active probe (D')** は reconnect では実行しない。これは `messages.fetch` を
全非終端 session 分叩く高コスト操作で、毎再接続で走らせると Discord rate limit を無駄に圧迫するため。
代わりに scheduler tick 側の opportunistic な `updateAskMessage` / `updatePostponeMessage` で
10008 (Unknown Message) を拾う既存経路に委ねる。

replay 後に `runStartupRecovery(...)` も再実行する。これは overdue ASKING / POSTPONE_VOTING の settle と
POSTPONED からの Saturday ASKING 作成を CAS で冪等に進める処理で、disconnect 中に発火した tick 取りこぼしを
吸収する。

## Consequences

### Positive
- Discord 切断中に発火した cron tick の副作用漏れを自動収束できる。
- 既存 startup 経路 (ADR-0033) と同じ invariant 実装を再利用しているため、新しい分岐を生まない。
- `AppReadyState` の切り替えで replay 中の interaction を load-shed でき、レース発生源を減らせる。
- In-flight lock + debounce で Discord rate limit への影響を抑える。

### Negative / Trade-offs
- reconnect 直後の短時間 (秒単位) は interaction が ephemeral で却下される。運用影響はごく小さい
  (4 名固定の想定利用で、同時押下が替え替えにぶつかる可能性は低い)。
- 30 秒 debounce 内の再接続では invariant 再計算が走らない。仮に disconnect が 30 秒内で 2 回発生しても、
  2 回目の replay は skip される。長時間 disconnect が再度発生した場合は次 shardReady で正常に replay される。
- reconnect scope の active probe 省略により、切断中に削除された Discord message (10008) は
  次回起動まで検知されない。scheduler tick の opportunistic 再描画 (updateAskMessage など) で拾えるが、
  すべての状態で 100% 拾えるわけではない (例: 描画トリガが発生しない DECIDED セッション)。
  実害を評価し必要があれば「軽量 probe (対象を絞る)」を検討する。

### Operational
- 調整値 (`RECONNECT_REPLAY_DEBOUNCE_MS`) は `src/config.ts` に集約。ADR/コメントに値は書き写さない
  (ADR-0022)。
- ログ event 名: `reconnect.replay_start` / `reconnect.replay_done` / `reconnect.replay_failed` /
  `reconnect.replay_skipped`。SRE / 運用者はこの event を指標に "disconnect は起きているが
  replay は収束しているか" を観測できる。

## Alternatives considered

1. **debounce のみ (in-flight lock なし)**: 30 秒内なら skip、それ以外は毎 shardReady で reconciler を
   起動。並列で走り得るため CAS 衝突・rate limit 消費で事故源になる。却下。
2. **scope="startup" をそのまま呼ぶ**: active probe D' を毎再接続で実行することになり、`messages.fetch`
   を全非終端 session 分叩く。本 bot 規模では即座に致命的ではないが、flappy 時の rate limit 消費が増える。
   却下し `scope="reconnect"` を新設した。
3. **replay 中も ready を維持**: interaction と replay 中の reconciler が並行して同じ session を触る
   リスクを受け入れる。startup gating の invariant (ADR-0033) と整合が取れず却下。
4. **Discord.js の `ready` イベントで代替**: `ready` は初回起動時 1 回のみ発火する。reconnect 時には
   `shardReady` のみ発火するため、本 ADR の用途に不適。却下。

## References
- ADR-0024 Reminder dispatch (cron tick の race)
- ADR-0033 Startup invariant reconciler (同じ invariant を再利用)
- ADR-0035 Discord send outbox (reconnect 時に outbox claim reclaim が効く)
- `src/index.ts` `triggerReconnectReplay` 実装
- `src/scheduler/reconciler.ts` `ReconcileScope = "reconnect"` 分岐
