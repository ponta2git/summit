---
adr: 0036
title: Reconnect replay on shardReady — in-flight lock + debounce + scope=reconnect
status: accepted
date: 2026-04-21
supersedes: []
superseded-by: null
tags: [runtime, discord, ops]
---

# ADR-0036: Reconnect replay on shardReady

## TL;DR
Discord WebSocket 再接続時に `client.on("shardReady", ...)` で reconciler（`scope="reconnect"`）+ `runStartupRecovery` を起動し、disconnect 中に発火した cron tick の副作用漏れを収束させる。3 安全装置: (1) `startupCompleted===false` は no-op、(2) in-flight Promise lock で並行実行禁止、(3) `RECONNECT_REPLAY_DEBOUNCE_MS` で flap 抑制。replay 中は `markAppNotReady("replaying")` で interaction を ephemeral 却下。`scope="reconnect"` は startup の高コスト active probe（D'）を省略。

## Context

Fly.io 単一インスタンス + node-cron 毎分 tick（ADR-0024, ADR-0033）では、Discord WebSocket が一時的に切断している間も cron tick は JST 現在時刻で発火する。このとき Discord API を叩く副作用（ask 初回投稿 / settle 後の再描画 / 開催決定メッセージ / outbox worker 配送等）は一時的に失敗する。

ADR-0033 startup reconciler はプロセス再起動時には効くが、「プロセスは生きていて Discord だけ再接続」のケースでは呼ばれず、disconnect 中に発火した tick の副作用が孤立する:

- 金 08:00 ask tick が投稿直前で切断 → `ASKING/askMessageId=NULL` のまま放置（N1 類似だが startup reconciler は呼ばれない）。
- 金 21:30 settle tick が途中で切断 → CANCELLED 中間停滞や outbox claim stuck。

加えて短時間の shardReady 多発（ネットワークフラップ）で replay を多重起動すると、reconciler 内の active probe / CAS が重複し Discord API rate limit を無駄消費する。

制約として: replay 中は dispatcher が interaction を処理しない設計にする必要があり（ADR-0033 の startup ready gating と整合）、また startup の D' active probe（全非終端 session への `channel.messages.fetch`）は再接続ごとに走らせると rate limit 消費が大きいため reconnect 時は抑制する必要がある。

## Decision

`client.on("shardReady", ...)` で reconnect-replay を起動。**3 安全装置**を併用する:

### Safety nets（3 layers）

1. **Startup gate**: `startupCompleted === false` の間は **no-op**。初回 ready は通常の startup パスで処理し replay 扱いしない。
2. **In-flight Promise lock**: `replayInFlight: Promise<void> | undefined` が非 undefined の間は新規 replay を起動しない。完了時に `markAppReady` し lock を解放。時刻 debounce 単独では並行実行を防げないため Promise-based lock が必須。
3. **Time debounce**: 直近の成功 replay から `RECONNECT_REPLAY_DEBOUNCE_MS` 以内は replay を skip し `markAppReady` のみ。flappy 再接続で reconciler を連打させない。

### Interaction gating during replay

- replay 中は **`markAppNotReady("replaying")`** を呼び、dispatcher 経由の interaction を ephemeral rejection。ADR-0033 の startup gating 機構を再利用（interaction と replay 中 reconciler が同 session を並行して触らない）。

### Reconciler: `scope="reconnect"`（新設）

- 実行する invariants: **A / B / C / E / F（outbox claim reclaim）**。
- **`startup` 限定 active probe (D') は reconnect では実行しない**: `messages.fetch` を全非終端 session に発行する高コスト操作のため、毎再接続で Discord rate limit を圧迫する。代替として scheduler tick 側 `updateAskMessage` / `updatePostponeMessage` の opportunistic な 10008 recovery に委譲。
- replay 後に **`runStartupRecovery(...)` も再実行**（overdue ASKING / POSTPONE_VOTING の settle と POSTPONED → Saturday ASKING 作成を CAS で冪等に進め、disconnect 中の tick 取りこぼしを吸収）。

### SSoT / Logging

- `RECONNECT_REPLAY_DEBOUNCE_MS` は `src/config.ts` に集約（ADR-0022）。ADR/コメントに値を書き写さない。
- ログ event: `reconnect.replay_start` / `reconnect.replay_done` / `reconnect.replay_failed` / `reconnect.replay_skipped`。

## Consequences

### Follow-up obligations
- `scope="reconnect"` では active probe (D') を意図的に省略している（@see Decision ### Reconciler: `scope="reconnect"`）ため、切断中に削除された Discord message (10008) は次回起動まで検知されない。scheduler tick の opportunistic 再描画で拾えないケース（例: 描画トリガの無い DECIDED セッション）が実害を持つようになった場合は、対象を絞った軽量 probe を追加する。

### Operational invariants & footguns
- **flap 時の rate-limit 保護**: `RECONNECT_REPLAY_DEBOUNCE_MS` 内の再接続では invariant 再計算を skip する。短時間に 2 回 disconnect が発生すると 2 回目は skip されるため、長時間 disconnect が再発した場合は次 shardReady で replay が走る前提を崩さない（@see Decision ### Safety nets（3 layers））。
- **interaction gate の責務**: replay 中は `markAppNotReady("replaying")` で `AppReadyState` を落とし、interaction dispatcher 側で ephemeral 却下する。replay 経路から直接 DB を触らない / gate を外さない。数秒の却下は 4 名固定運用で許容。
- 調整値（`RECONNECT_REPLAY_DEBOUNCE_MS`）は `src/config.ts` に集約（ADR-0022）。ログ event 名（`reconnect.replay_start` / `reconnect.replay_done` / `reconnect.replay_failed` / `reconnect.replay_skipped`）は SRE 指標として固定維持する。

## Alternatives considered

- **debounce のみ（in-flight lock なし）** — 並列実行で CAS 衝突・rate limit 消費の事故源となるため却下。
- **`scope="startup"` をそのまま呼ぶ** — active probe D' を再接続ごとに実行し `messages.fetch` が全非終端 session 分走り、flappy 時の rate limit 消費が増えるため `scope="reconnect"` を新設、却下。
- **replay 中も ready を維持** — interaction と replay 中 reconciler が同一 session に並行アクセスするリスクが ADR-0033 の startup gating invariant と整合しないため却下。
- **discord.js の `ready` イベントで代替** — `ready` は初回のみ発火し reconnect 時は `shardReady` のみのため不適、却下。

## References
- ADR-0024 Reminder dispatch (cron tick の race)
- ADR-0033 Startup invariant reconciler (同じ invariant を再利用)
- ADR-0035 Discord send outbox (reconnect 時に outbox claim reclaim が効く)
- `src/index.ts` `triggerReconnectReplay` 実装
- `src/scheduler/reconciler.ts` `ReconcileScope = "reconnect"` 分岐
