---
adr: 0051
title: Session 集約コマンドと順序付き Discord delivery intent
status: accepted
date: 2026-08-08
supersedes: [0024, 0033, 0035, 0038]
superseded-by: null
tags: [runtime, db, discord, ops, docs, time, testing]
---

# ADR-0051: Session 集約コマンドと順序付き Discord delivery intent

## TL;DR

Session に対する回答・状態遷移・Discord 投稿 intent を集約コマンド内の単一 transaction で確定し、intent は Session ごとの順序と claim fencing を持つ outbox worker で配送する。リマインドの旧 claim-first 経路を廃止し、Discord 受理後の開催履歴確定を outbox 完了処理に含める。

## Context

ADR-0035 の初期 outbox は順序非依存な投稿だけを対象とし、募集、締切通知、順延投票、リマインドは直接送信のまま残していた。このため、DB 更新と Discord 投稿の間で process が停止すると、状態だけ進む欠落と再実行による順序逆転を経路ごとに扱う必要があった。

回答保存と状態遷移も別 repository call だったため、同じ利用者から遅れて届いた Interaction、締切処理、別ボタン処理が異なる snapshot を評価し得た。週取消は複数 Session と開催履歴をまたぐため、部分適用を防ぐ transaction 境界も必要だった。

Discord API と Postgres を同一 transaction に参加させることはできない。したがって、外部副作用について exactly-once を装うのではなく、欠落防止、重複許容、順序保証、競合所有権を明示する必要がある。

## Decision

1. `SessionCommandsPort` を Session 集約の書込み境界とする。実装は Session を先に lock し、member・締切・Response を同じ snapshot で検証してから、回答、状態遷移、aggregate sequence、delivery intent を単一 transaction で確定する。
2. Interaction 由来の Response は Discord snowflake の大小で fencing する。遅れて到着した古い Interaction は保存済み回答と aggregate sequence を変更しない。
3. 新規 Discord 投稿のうち業務上必須なものは typed delivery intent として outbox に保存する。初回募集と順延後募集も Session 作成と同じ transaction で enqueue する。既存メッセージの再描画は DB 正本からの best-effort edit と reconciler に残す。
4. 各 intent は Session aggregate sequence と同一変更内 ordinal の組で順序付け、DB でもその組を Session 内一意にする。worker は未完了または dead-letter の先行 intent がある後続を claim しない。先行 intent が dead-letter になった場合は既存の後続を取消し、後から作られた後続も配送前に取消す。
5. claim ごとに所有権 token を発行し、配送成功・失敗の確定は同じ token の所有者だけに許可する。期限切れ claim を別 worker が再取得した後、古い worker の確定は no-op にする。
6. reminder scheduler は due intent の enqueue のみ行う。worker は Discord 受理後に Session 完了と HeldEvent 作成を同一 transaction で確定し、その後 outbox を完了する。この区間の crash では欠落より重複を選ぶ。送信不要条件では従来どおり Discord を介さず完了する。
7. 週取消は対象 Session を決定論的順序で lock し、HeldEvent の有無、全対象の skip、旧 intent の取消、通知 intent を単一 transaction で確定する。Session 未作成時の sentinel と同時作成の競合は unique winner を再取得して同じ処理へ収束させる。
8. ADR-0024 固有の reminder claim API、stale-claim reconciler、設定、テストを削除する。migration は旧方式の中間 marker を暗黙に書き換えず、残存時は fail-closed で中断して運用者レビューを要求する。移行後、その marker は完了結果としてのみ書く。
9. `dedupe_key` は status を問わず一意とし、FAILED の再試行で別 row を作らない。startup reconciler は FAILED row とそれが取消した後続を同一 transaction で PENDING に戻し、試行回数を初期化する。この復帰は process 起動時だけ行い、定期 tick や reconnect では poison payload の hot loop を作らない。
10. `askMessageId` / `postponeMessageId` が欠けた非終端 Session は Discord へ直接再投稿せず、現在 revision の予約 ordinal に recovery intent を enqueue する。通常作成済み intent とは同じ dedupe key で収束し、startup direct-send と worker の二重投稿競合を除く。外部で削除済みと判定できた既存メッセージの再生成は従来どおり best-effort reconciler が担う。
11. outbox の kind は実装済みの `send_message` のみに限定する。既存メッセージ edit は DB 正本から再構築する best-effort 経路に残し、実装も生成経路もない `edit_message` 宣言は削除する。

実装上の列・status・閾値・renderer 名は `../momo-db/src/schema.ts`、`src/config.ts`、`src/db/repositories/sessionOutboxIntents.ts` を SSoT とする。

## Consequences

- DB transaction と Discord API の間は at-least-once のままであり、受理後 crash では重複投稿があり得る。一方、DB commit 前後の crash で必須投稿が永久欠落する経路は減る。
- 同一 Session は head-of-line blocking を受ける。これは意味順序を守るための意図的な制約で、異なる Session は batch 内で並列配送する。
- dead-letter は稼働中のその Session の後続投稿を止める。`/status`、outbox metrics、構造化ログで原因を確認して修正を deploy すると、次回 startup が同じ row と後続を再試行可能状態へ戻す。恒常的な不正 payload は再起動ごとに一度だけ retry cycle を消費する。
- Interaction handler と deadline scheduler の事前 Response fetch が不要になり、DB round trip と stale snapshot が減る。Discord render 用 read は transaction 外で行い、row lock を API 待ちに持ち越さない。
- schema migration と application は互換期間を保って順に適用する必要がある。禁止窓と migration 手順は `AGENTS.md` と `docs/operations/migration.md` に従う。
- migration の preflight が旧 reminder claim、重複 dedupe key、未対応 outbox kind を検出した場合はデータを変更せず停止する。guard を迂回せず、backup と監査結果を揃えて別途解消する。
- Fake port は sequence 一意性、snowflake fencing、ordered claim、dead-letter cancellation / startup recovery、transaction rollback の意味を real port と揃える。重要な競合は実 DB contract test でも固定する。

## Alternatives considered

- **状態遷移後に同期 Discord 送信を継続** — crash gap と経路別 retry が残り、順序を一元的に保証できないため却下。
- **Discord 送信を DB transaction 内で待つ** — 外部 API 遅延中に lock を保持し、contention と transaction failure の範囲を拡大するため却下。
- **aggregate sequence を持たず作成時刻順に配送** — 同時刻、retry、後発 enqueue で業務上の因果順序を表現できないため却下。
- **claim 期限だけで所有権を判断** — reclaim 後の古い worker が新 owner の結果を上書きできるため却下。
- **外部 message broker を導入** — 現行規模では追加インフラと二重の運用正本が利点を上回るため却下。

## Re-evaluation triggers

- 複数 application instance または複数 outbox worker を常時稼働させるとき。
- Discord が idempotency key または transactionally consumable な delivery API を提供したとき。
- head-of-line blocking が許容できない独立副作用を同一 Session に追加するとき。
- DB outbox の量・latency・運用負荷が外部 broker の導入コストを上回ったとき。

## Links

- docs/adr/0001-single-instance-db-as-source-of-truth.md
- docs/adr/0018-port-wiring-and-factory-injection.md
- docs/adr/0023-cancel-week-command-flow.md
- docs/adr/0024-reminder-dispatch.md
- docs/adr/0031-held-event-persistence.md
- docs/adr/0033-startup-invariant-reconciler.md
- docs/adr/0035-discord-send-outbox.md
- docs/adr/0047-db-driven-conditional-scheduler.md
- src/db/repositories/sessionCommands.ts
- src/db/repositories/outbox.ts
- src/scheduler/outboxWorker.ts
