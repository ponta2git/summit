---
adr: 0044
title: Time skew behavior contract — JST 固定運用下のサーバ clock 異常時挙動
status: accepted
date: 2026-04-25
tags: [time, runtime, ops]
supersedes: []
superseded-by: null
---

# ADR-0044: Time Skew Behavior Contract

## TL;DR

Fly.io の host NTP に依存して system clock が正しく JST と同期している前提で運用する。**サーバ clock が ±数秒以上ずれた場合の挙動を本 ADR で明文化** し、(1) 軽微な skew (<1 分) は cron / 締切判定の通常許容範囲、(2) 中程度の skew (1〜30 分) は週 session の取りこぼしや重複が起きうる範囲、(3) 重大な skew (>30 分) は運用者手動介入領域、として境界を確定する。skew 検知の自動化は導入せず、`/status` の `now` 表示と Discord 上の体感差で運用者が気付く現行モデルを維持する。

## Context

Summit は固定 4 名・週 1 回の桃鉄出欠 Bot で、すべての時刻判定を JST 基準で行う（ADR-0002）。`process.env.TZ="Asia/Tokyo"` を起動時に設定し、cron は `node-cron` の `timezone: "Asia/Tokyo"` で発火する（`src/scheduler/index.ts`）。締切判定 / 週キー / 順延期限はすべて `ctx.clock.now()` 経由で `Date` を取得する。

### 現状の time-dependent 経路

- **cron 発火**: `node-cron` が host clock の wall-clock を JST 解釈で評価して tick を出す。host clock が遅れている場合、cron tick も遅れる。
- **締切判定** (`findDueAskingSessions` 等): `deadline_at <= now` を postgres-side で評価。`now` は app 側から渡される `ctx.clock.now()`。
- **週キー** (`isoWeekKey`): `getISOWeek` + `getISOWeekYear` を `now` から算出。年跨ぎ境界 (12/31 金 → 1/1 土) を厳格に処理。
- **reminder claim 失効**: `REMINDER_CLAIM_STALENESS_MS=5min`。skew で `reminder_sent_at` と `now` がずれると reclaim タイミングが移動。
- **outbox claim 失効**: `OUTBOX_CLAIM_DURATION_MS=30s`。同様に skew で release タイミングが移動。

### 想定されるリスク

Fly.io host は KVM ベースで NTP 同期されているのが通常だが、(1) host migration 直後、(2) NTP daemon 停止、(3) container 内 clock 異常 (極端に稀) で system clock が wall-clock JST から乖離するシナリオはゼロではない。Bot は単一インスタンス常駐 (ADR-0001) で「正本としての DB」を持つため、skew 中でも DB 状態の整合性は保たれるが、**ユーザー体感 (Discord 投稿時刻の前後) と cron 発火タイミング** がずれる可能性がある。

### なぜ今これを決めるか

15 軸品質レビュー (`docs/reviews/2026-04-24/09-robustness.md` 改善提案 L) で「時刻 skew 挙動が仕様化されていない」が指摘された。skew の自動検知 / 補正は実装複雑度の割に効果が薄い (Fly NTP の信頼性に依存しているのが常態) ため、**振る舞い仕様の明文化** に範囲を絞る。

## Decision

### 1. NTP 同期は host (Fly.io) を信頼する

- 自前の NTP query / SNTP は導入しない。
- 起動時の clock sanity check も導入しない (起動時点で skew があっても代替時刻ソースが無い)。
- **唯一の例外**: `/status` コマンドが `now` を JST 表示する。運用者が Discord 上で目視確認できることを skew 検知の primary path とする。

### 2. Skew 規模ごとの振る舞い契約

| skew 規模 | 想定原因 | 振る舞い | 運用者 action |
|---|---|---|---|
| **<1 分** | 通常 NTP jitter | cron は ±数秒のずれで発火、締切は ±数秒で評価。ユーザー体感では区別不能 | 不要 |
| **1〜10 分** | 短時間 NTP 異常 | (a) 募集投稿が 08:00 JST から数分遅れる、(b) 21:30 締切判定が数分後にずれ込む、(c) reminder 15 分前送信がずれる。**機能的取りこぼしは無い** (deadline は relative 比較のため、now が遅れても deadline 通過判定が遅れるだけ) | 復旧後の cron tick で自動収束。手動介入不要 |
| **10〜30 分** | NTP daemon 停止 | (a) 募集を 08:30 JST 以降に投稿してしまう、(b) **金曜 21:30 の締切判定が遅れて土曜 0:00 (順延期限) を跨ぐと順延期限超過判定で意図しない遷移**が起きうる、(c) reminder が候補時刻後に送信される | `/status` で `now` 表示を確認し、host 側 NTP を再起動。週 session 状況によっては手動 `/cancel_week` 検討 |
| **>30 分** | clock 異常 / NTP 完全停止 | 週キー算出が誤った週を返す可能性。`weekKey` mismatch で **同一週に二重 session が作られる懸念** (`(weekKey, postpone_count)` unique で bounded だが、誤った週キーで作成された session は当該週にゴーストとして残る) | **deploy 禁止窓 (金 17:30〜土 01:00 JST) 内なら緊急手動 SQL 不可。窓外で `/status` 確認 + Fly machine restart で host clock 再取得** |

### 3. 取りこぼし防止の依存先

skew が起きても致命的取りこぼしを起こさない設計上の根拠を本 ADR で記録する:

- **reconciler invariant B (missingAsk, ADR-0033)**: 金曜 ASK 窓 (`ASK_START_HHMM`〜`ASK_DEADLINE_HHMM`) 内に session が無ければ作る。skew で 08:00 cron を逃しても、その後の 1 分 tick reconciler が窓内なら拾う。
- **reconciler invariant E (staleReminderClaims)**: claim から 5 分超で reclaim。skew でも `reminder_sent_at` と `now` の相対差で判断するため、相対値が狂わない限り収束する。
- **CAS-on-NULL (ADR-0024)**: reminder 二重送信は claim-first で物理的に排除。skew でも DB 上の状態遷移整合性は崩れない。
- **outbox at-least-once (ADR-0035)**: 配送は冪等な dedupe_key で 1 行に collapse。skew で worker tick がずれても二重配送は起きない。
- **(weekKey, postpone_count) unique (ADR-0009)**: 30 分超の skew で誤った週キーが算出されても、二重 session 作成は DB 制約で物理的に block。

### 4. 検知と運用 SOP

- **primary**: `/status` の `now` 表示を運用者が定期的 (週 1 回程度) に Discord 上で確認。
- **secondary**: H-2 (ADR-0043) で導入した outbox metrics の `event=outbox.metrics` ログを Fly logs 上で確認。`oldestPendingAgeMs` が想定外に大きい場合は skew 由来の cron 遅延を疑う。
- **detection 時の SOP**:
  1. `/status` で `now` を確認、Discord 上の現実時刻と差を測定。
  2. Fly logs で `event=cron.tick` が遅延発火していないか相互確認。
  3. **skew >10 分 を確認したら**: deploy 禁止窓外で `fly machine restart <machine-id>` を実施し host clock 再取得を試みる (Fly host migration による NTP re-sync を狙う)。
  4. 週 session が impacted な場合: `/status` で当該週の session 状態を確認し、必要なら `/cancel_week` で SKIPPED 化。

### 5. 自動補正 / 自動検知は導入しない

理由:

- **Fly.io 上の NTP 異常頻度は極めて低い** (公開 incident 履歴に host clock skew 単独の事例なし)。
- **clock skew 検知のための外部依存 (NTP query) は単一インスタンス常駐 Bot のスコープ外** (新規依存 + 失敗経路追加コストに見合わない)。
- **DB 状態整合性は CAS / unique 制約で保護されている** ため skew が「壊滅的失敗」になりにくい。

## Consequences

### 正の影響

- 運用者が「skew が起きたらどうなるか」を本 ADR で参照できる。トリアージ時間の短縮。
- 「自動検知を導入しない」判断が明文化され、将来の機能追加要望 (NTP query / clock drift alert 等) に対する基準が確立。
- skew 中の DB 整合性が保たれる根拠 (CAS / unique / reconciler) が一覧化され、回復性軸 (13) のドキュメント補強。

### 負の影響 / 受容するリスク

- 10〜30 分 skew 域での「金曜 21:30 締切判定が土曜 0:00 を跨ぐ」誤遷移シナリオは仕様上許容する (頻度極低のため)。
- `/status` の `now` 表示を運用者が定期確認する運用負担が残る (週 1 回程度を想定)。
- skew 自動検知の代替として運用者の経験則に依存する。

## Alternatives considered

### A. 起動時 NTP query で skew check + 大幅 skew で起動拒否

却下理由:
- NTP server (e.g., `pool.ntp.org`) を新規依存に加えるコスト。
- skew があっても起動拒否すると Bot 完全停止になり、可用性が下がる方向。
- 起動時のみ check しても running 中の skew 発生は捕捉できない。

### B. 1 分 cron tick ごとに前回 tick との相対 skew を監視 + 閾値超過で warn ログ

却下理由:
- `node-cron` 自体が wall-clock 依存のため、相対 skew 監視も信頼性に難。
- warn ログが出ても運用者の対応 SOP は本 ADR (Fly machine restart) と変わらず、ログ自動化に対する benefit が薄い。
- 将来的な再評価 trigger には残す (下記 Re-evaluation triggers)。

### C. PostgreSQL 側の `now()` を SSoT にして app 側 clock を一切信用しない

却下理由:
- DB と app の skew が分離する複雑性 (二箇所の時刻ソース)。
- 既存コードベース全体が `ctx.clock.now()` で構築されており、refactor cost が極大。
- DB host も別 NTP に依存するため、根本解決にならない。

## Re-evaluation triggers

- Fly.io 上で **実際に skew incident が観測された**場合 → 検知自動化 (代替案 B) の再評価。
- メンバー数増加 / 複数 channel 化など **scale 拡大**で `/status` 目視運用が現実的でなくなった場合。
- `node-cron` から別 scheduler (e.g., `croner`) への移行時に skew 耐性が改善される場合。

## Links

- ADR-0001 単一インスタンス + DB 正本 (skew 中も DB 整合性が保たれる根拠)
- ADR-0002 JST 固定 (`process.env.TZ` / `src/time/`)
- ADR-0009 (weekKey, postpone_count) unique (二重 session 作成の物理ガード)
- ADR-0024 reminder claim-first (二重送信防止)
- ADR-0033 startup / tick reconciler (skew 復旧後の自動収束)
- ADR-0035 outbox at-least-once (二重配送防止)
- ADR-0043 outbox observability metrics (skew 兆候の secondary detection)
- `docs/reviews/2026-04-24/09-robustness.md` 改善提案 L (本 ADR の起点)
