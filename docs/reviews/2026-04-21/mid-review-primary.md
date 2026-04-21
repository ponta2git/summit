# Mid-Review Primary — Phase I1 + I2 (commits 3245f2c..80781a9)

## Summary

Phase I1+I2 は C1/N1/H1 を「DB を正本とした reconciler + edge-specific state API + 観測コマンド + CI/運用ハードニング」で順当に閉じており、スキーマ・ADR・SSoT ガードは全体として整合している。I1 の edge-specific state API は CAS 契約を保ったまま `transitionStatus` を置換しており、transitionStatus 残渣は src/ に存在しない（コメント内の history 言及のみ）。一方で reconciler の宙づり CANCELLED 回復経路は、通常 `settleAskingSession` が担う Discord 側の UI 片付け（ASK メッセージ無効化・settle 通知投稿）を実施しないため、crash 由来の復旧時にユーザー可視の不整合が残る。I3 でふさぐべき高優先度が 2 件、中程度が 3 件、ブロッカーは 0 件。

## Blockers

なし。

## High-priority

### H-P1: reconciler の Friday stranded CANCELLED 復旧が ASK メッセージを無効化せず settle 通知も送らない

**File:** `src/scheduler/reconciler.ts:141-156`（`promoteStranded` 金曜パス）
**Severity:** High
**Problem:** 通常経路 `settleAskingSession` (`src/features/ask-session/settle.ts:54-66`) は `cancelAsking` 後に **`updateAskMessage(cancelled)` で ASK メッセージのボタンを無効化**し、**`channel.send(renderSettleNotice(...))` で中止通知を投稿**してから `startPostponeVoting` へ進む。reconciler の金曜パスはその 2 ステップを飛ばし、いきなり順延投票メッセージを投げて `startPostponeVoting` する。その結果、crash 復旧後のユーザーには「活きた ASK ボタン付きの前週メッセージ」と「唐突に現れた順延投票メッセージ」が並ぶ。ADR-0033 の「自動収束の単一入口」として通常経路と同じ可視化が期待される。副作用としてユーザーが stale ASK を押下する経路が増え、`handleAskButton` 内の status ガードに依存することになる。
**Evidence:** `settleAskingSession` と `promoteStranded` を比較。前者は `updateAskMessage` と `renderSettleNotice` を送出、後者は `getTextChannel` → `channel.send(renderPostponeBody(...))` → `updatePostponeMessageId` → `startPostponeVoting` のみ。テストも UI 片付けを検証していない（`tests/scheduler/reconciler.test.ts` は送出されたメッセージ数しか見ていない）。
**Suggested fix:** `promoteStranded` 金曜パスの冒頭で、`updateAskMessage(client, ctx, session)`（messageEditor 版、fresh 再取得付き）を呼び、次に `channel.send(renderSettleNotice(buildSettleNoticeViewModel(resolvedReason)))` を送ってから順延投票メッセージの送信に進む。`resolvedReason` は CANCELLED row の `cancelReason` から導出する（ADR-0001 で保存済み）。

### H-P2: Saturday stranded CANCELLED を COMPLETED に寄せる時も UI 片付けが抜けている

**File:** `src/scheduler/reconciler.ts:120-128`（`promoteStranded` 土曜パス）
**Severity:** High
**Problem:** 土曜回（`postponeCount=1`）の CANCELLED 宙づりを `completeCancelledSession` で COMPLETED に寄せるが、同じく ASK メッセージの `disabled` 再描画と channel の settle 通知は行わない。通常の `settleAskingSession` は `cancelled.postponeCount === 1` 分岐でも `updateAskMessage` と `renderSettleNotice` を **事前に** 実行してから `completeCancelledSession` に到達する（`src/features/ask-session/settle.ts:68-92`）。crash が `cancelAsking` 直後〜`updateAskMessage` 前で起きた場合、土曜 ASK メッセージはボタンアクティブのまま DB は COMPLETED という乖離が永続化する。
**Evidence:** 上記と同じ比較。reconciler の該当ブロックには channel.send も msg.edit も出現しない。
**Suggested fix:** H-P1 と同じ箇所で、COMPLETED に寄せる前に `updateAskMessage` と settle 通知 `channel.send` を実行する。ただし「Discord 送信済み」が先行している crash パターン（settle 通知が既に投稿済み）では二重投稿になる。冪等性はベストエフォートでよい（DB-as-SoT の精神）ため、最悪 1 通の重複を受容する旨をコメントで明示する。

## Medium

### M1: `isFridayAskWindow` が "08:00" を直書きしており ADR-0022 の SSoT 方針に反する

**File:** `src/scheduler/reconciler.ts:60-66`
**Problem:** `hour > 8 || (hour === 8 && minute >= 0)` と直書きしている。ADR-0022 は「cron 式・時刻閾値を ADR/コメントに書き写さない」を求め、reminder 系 (`ASK_DEADLINE_HHMM` / `REMINDER_CLAIM_STALENESS_MS`) は `src/config.ts` に集約されている。現状の cron 送信時刻は `CRON_ASK_SCHEDULE = "0 8 * * 5"` (config.ts:7) のみが正本で、reconciler ファイル側に独立した `8` リテラルが生じると 08:00 変更時に 2 箇所同期が必要になる。ADR-0033 の参照節も「実装値の SSoT: `src/config.ts`」を明言。
**Suggested fix:** `src/config.ts` に `ASK_START_HHMM = { hour: 8, minute: 0 } as const satisfies Hhmm` を追加し、`CRON_ASK_SCHEDULE` と `ASK_START_HHMM` が同一値を示す旨を config 側コメントで明記。reconciler は `ASK_START_HHMM` を import して `isFridayAskWindow` を書き換える。

### M2: reconciler 内の `new Date(...)` が `src/time/` を経由していない

**File:** `src/scheduler/reconciler.ts:310`
**Problem:** `const cutoff = new Date(now.getTime() - REMINDER_CLAIM_STALENESS_MS);` は AGENTS.md §1「時刻計算は `src/time/` に集約、他所で `new Date()` 禁止」のルールに形式的に違反する。デルタ計算なので壁時計漏れではないが、ルール遵守のため time 側に `subMs(now, ms: number)` のような薄い helper を置いて経由するのが無難。
**Suggested fix:** `src/time/` に `subMs` か `staleReminderClaimCutoff(now)` を追加し import。あるいは ctx.clock に `subMs` を生やす。

### M3: boot ping が timeout なし `fetch` のまま

**File:** `src/index.ts:150-154`
**Problem:** `void fetch(pingUrl).catch(...)` は `AbortController` / `AbortSignal.timeout` を持たないため、ping URL が DNS 不達やハングで返ってこないと Promise は永久に保留される（Node の fetch はデフォルト timeout を持たない）。fire-and-forget で起動をブロックはしないが、参照が残るため GC されず、再起動まで 1 件ずつ累積する可能性がある。healthchecks.io 側が落ちた場合に影響が分かりにくい。
**Suggested fix:** `AbortSignal.timeout(5_000)` を渡す。`fetch(pingUrl, { signal: AbortSignal.timeout(5000) })`。

## Nits

- `src/logger.ts` の redact path に `error.cause.headers.Authorization` は含むが小文字の `error.cause.headers.authorization` も登録済み。discord.js v14 が `rawError` や `response.body` にトークン断片を載せる経路は redact していない。観測上問題が出たら追加、の判断は妥当。
- `src/db/repositories/sessions.ts:504` のコメントに「`transitionStatus` と違い」と旧 API 名が残る。I2 完了後は「edge-specific API の中で唯一 from を複数許す」の表現に言い換えると readers フレンドリー。
- `src/scheduler/reconciler.ts:51` の `FRIDAY_JS_DAY = 5` も M1 と同じ方向で config 化の余地（ただし Date#getDay の既約定数なので据え置きも許容）。
- fly.toml のコメントに「kill_timeout = 30s」は `shutdownGracefully` のタイムアウト設定と整合しているかを将来の shutdown 改修時に再確認する価値あり（現状は問題なし）。

## Not issues（キャリブレーション用：疑って確認したが実害なし）

- **`findStaleReminderClaims` が `reminderSentAt IS NULL` を除外していないように見える**：SQL の `reminder_sent_at <= cutoff` は PostgreSQL で NULL を除外するため、`isNull` を追加しなくても fresh claim 済み以外の行（NULL）は結果に現れない。index `idx_sessions_status_reminder (status, reminder_sent_at, reminder_at)` も `status='DECIDED'` prefix + `reminder_sent_at` range で活用される。正しい。
- **reconciler が `runStartupRecovery` より先に走ることで POSTPONE_VOTING への promoted session が `runStartupRecovery` で即 settle される race**：`startPostponeVoting` は `deadlineAt = 候補日翌日 00:00 JST` をセットする。reconciler が promote した直後に `runStartupRecovery` が `findNonTerminalSessions` を引き、POSTPONE_VOTING 分岐で `session.deadlineAt <= now` を評価しても、candidate 翌日まで時間があるため false となり二重遷移は起きない（reconciler 自体が「期限前」判定で入ってきている）。
- **`reconcileMissingAsk` が存在する COMPLETED 週次 session を誤って再作成しない**：`findSessionByWeekKeyAndPostponeCount(weekKey, 0)` は status フィルタ無しの存在チェックなので、`reconcileStrandedCancelled` が同 tick で CANCELLED→COMPLETED に寄せた行をそのまま存在ありとして検出し、`reconcileMissingAsk` は早期 return する。冪等性は保たれる。
