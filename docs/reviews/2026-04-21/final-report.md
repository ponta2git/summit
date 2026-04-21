# Summit 包括レビュー最終レポート (Phase R9 反映版)

By Claude Opus 4.7 (main agent) — 統合入力: 21 findings (TA1-TA8 / TP1-TP7 / TS1-TS6) + R7 cluster critique (GPT-5.4) + R7 Haiku critique (GPT-5.4) + **R9 final critique (GPT-5.4) を反映**

---

## 0. Executive Summary

| 深刻度 | 件数 | 代表 |
|---|---|---|
| **Critical** | **1** | C1 CANCELLED 宙づり (仕様違反 + 自動回復不能 → **その週の会が失われる**) |
| **Near-Critical** | **1** | N1 週次 ask publication/recovery gap (**未作成 ask の補完 + 削除された Discord message の再投稿が両方とも無い**) |
| High | 3 | TA5 F1 (状態機械), TS5 F1 (CI permissions), N1 構成要素群 |
| Medium | 約 23 | 観測性 / dep graph / CI 固定化 / test gap / `/status` 未実装 / ADR ↔ spec drift 等 |
| Low / Info | 約 15 | 誤検知・軽微 |

**一言**: *「通常運用は概ね正しく動く。ただし (a) CANCELLED 仕様と実装の乖離、(b) restart/crash または Discord 側メッセージ削除時の自動回復経路が途切れる、(c) fly.toml/healthcheck ping/CI permissions の機械的強制不足、の 3 点で“該当週の 4 人回”を静かに落とす可能性がある (翌週以降は `weekKey` が更新されるので継続可能)。修正優先は invariant-based startup reconciler + edge-specific state API + DB transaction + outbox パターンによる publish の再現性確保が最大レバレッジ。」*

**R9 critique 反映点**: (1) C1 を「bot が停止」でなく「該当週が失われる」に wording 修正 (翌週は新 `weekKey` で継続)。(2) H5 (sessions index) と H1 (ready log) を Medium に降格。(3) N1 に「削除された Discord message の recovery gap」を統合。(4) 新 Medium: `/status` command 未実装 (仕様要件)。(5) ADR-0007 (08:00 ask) と `requirements/base.md` (18:00 記載) の drift 解消を ADR 計画に追加。

---

## 1. Critical / Near-Critical

### C1. CANCELLED が「一時状態」のはずが終端化し、自動回復されない [Critical]
- **根拠**: TA5 F1 / TA6 F2 / TS4 F1 / TP5 F2 / R7 cluster critique / R9 critique で framing 確定
- **現象**:
  1. 仕様 (`requirements/base.md:227-233,269-275`) では CANCELLED は金曜 ask→postpone 投票開始の中間状態のみ、土曜中止・順延 NG/未完は COMPLETED に収束すべき
  2. 実装は土曜中止 (`features/cancel-week/settle.ts`) も順延 NG/未完 (`features/postpone-voting/settle.ts:83-89`) も CANCELLED 止まり (長寿命化)
  3. 金曜 ASKING→CANCELLED→POSTPONE_VOTING が 3 段分割 (`features/ask-session/settle.ts:45-77`) で、中間 CANCELLED でプロセス crash すると宙づり
  4. startup recovery (`src/scheduler/index.ts:166-209`) は CANCELLED に処理分岐なし
- **影響範囲の正確な wording (R9 反映)**:
  - **該当週 (stranded CANCELLED 発生週) は失われる**: 同 `weekKey` + `postponeCount=0` の row が unique (`src/db/schema.ts:72-79`) で残るため `/ask` もブロック、manual 救済は limited
  - **翌週以降は継続される**: 金曜 ask 時に `isoWeekKey` で新しい `weekKey` が計算されるため (`src/time/index.ts:39-45`, `src/features/ask-session/send.ts:51-57`) bot 自体が死ぬわけではない
- **Severity 論拠**: 仕様違反 + 週次 1 回しかないイベントをその週に限って自動で落とす + manual 救済手段が限定的 → 単発 High × 複数ではなく真の Critical
- **修正**: (a) CANCELLED を短寿命中間状態として型制約、(b) 土曜中止・順延 NG/未完は `completeCancelledSession` (COMPLETED) 専用 API、(c) Friday cancel→postpone 遷移を DB transaction で state/outbox/claim をまとめる (Discord 送信自体は atomic にならないので recoverable publisher が担当)、(d) startup reconciler が stranded CANCELLED を検知して次の正規状態へ引き上げる

### N1. 週次 ask publication/recovery gap [Near-Critical] (R7 cluster critique で新規検出、R9 で拡張)
- **根拠**: TP1 F2 / TS4 F2 / TP5 F3 + R9 新規指摘 (deleted Discord message)
- **現象**:
  1. 週次金曜 ask は cron 時刻の「その瞬間にプロセス生きている」前提 (`src/scheduler/index.ts:73-86`)
  2. startup recovery は **既存 non-terminal session の継続のみ** で、「今週 ask がまだ作られていない」ケースを補完しない
  3. createAskSession 成功 → channel.send 失敗 → `askMessageId=NULL` のまま放置、unique (`weekKey, postponeCount`) で再作成不能 (`src/features/ask-session/send.ts:77-117`, `schema.ts:76-79`)
  4. **(R9 追加) 削除された Discord message は回復手段なし**: ask/postpone message を誰かが削除すると DB は健全に見え (session 行あり)、`/ask` は duplicate-check でスキップ (`src/features/ask-session/send.ts:57-75`)、editor は fetch/edit 失敗を warn するだけ (`src/features/ask-session/messageEditor.ts:15-31`, `src/features/postpone-voting/messageEditor.ts:17-37`)、startup recovery は Discord 側の存在確認をしない
- **Severity 論拠**: C1 の次に「週の募集消失」を直接起こす。rolling deploy の restart、send 失敗、削除 の 3 経路で該当週を失う
- **修正**:
  1. startup 時に「今週の ASKING session が存在しかつ askMessageId が埋まっているか」を invariant として確認、欠落していれば送信 retry or 作成
  2. send 失敗時に行を削除 or `askMessageId` 欠損を reconciler が拾う
  3. reconciler で Discord API 経由の message existence 検証を ask/postpone message に対して行い、欠損時は既存 session を参照して再送信 + messageId 更新

---

## 2. High 深刻度 Findings

### H1. reminder が claim 後 crash で永久 stuck [TA5 F3 / TP3 F1 / High]
- `claimReminderDispatch` が送信前に `reminderSentAt=now` 立てるが、以後の held_event 作成前に crash すると `DECIDED + reminderSentAt!=NULL + held_event absent` となり、tick/recovery とも `IS NULL` 前提で拾えない
- ADR-0024 は **既知残余リスクとして明示受容**しているが、cluster critique の指摘どおり **受容条件と補償策 (stale-claim detector / warn log / manual reclaim コマンド)** が書かれていないため、運用 runbook なしでは無防備
- **修正**: (a) startup reconciler で stale claim を検知 → warn log & 自動 reclaim、(b) ADR-0024 に受容条件 / 補償策 / runbook を追記、(c) `DECIDED + reminderSentAt!=NULL + held_event absent` を拾う recovery query

### H2. CI permissions 未明示 (GITHUB_TOKEN デフォ依存) [TS5 F1 / High]
- `.github/workflows/ci.yml` に workflow/job 両レベルで `permissions:` なし。repo 設定によっては write-all 効く
- test/build-only ワークフローで write step はないが、PR からの fork run が将来追加された場合のリスクと最小権限原則から High 維持 (R9 では borderline と評価されたが、対応コストが極小なので High 扱いで即対応推奨)
- **修正**: 先頭に `permissions: { contents: read }`、必要 job のみ加算

### H3. 状態機械 任意遷移許容 [TA5 F2 / High]
- `transitionStatus` が任意 from/to を許す CAS + 非 tx (`src/db/repositories/sessions.ts:146-196`、`src/db/ports.ts:48-77`)。C1 の温床になっている
- **修正**: edge-specific port (`cancelAsking` / `startPostponeVoting` / `completePostponeVoting` / `decideAsking` / `completeCancelled`) 化、許可遷移 union を型で閉じる

---

## 3. Medium / Low (cluster ごと)

### M0. ready ログが ready を表していない [TP1 F1 / Medium] (R9 で High → Medium に降格)
- 現況: `"Discord bot started."` は `client.login` 直後で `runStartupRecovery`/scheduler 登録より前 (`src/index.ts:77-92`)
- SRE 視点の ready 判定に使えず、healthcheck/ping 設計全体の基礎が崩れる (実害は M2 と組み合わさった場合に大きくなる)
- **修正**: `phase=login|reconcile|startupRecovery|scheduler|ready`, `elapsedMs`, `bootId` を付与、ready は scheduler 生成後の専用 log

### M1. sessions 期限系 SELECT が未 index [TP5 F1 / Medium] (R9 で High → Medium に降格)
- `findDueAskingSessions` / `findDuePostponeVotingSessions` / `findDueReminderSessions` が `status+deadlineAt` / `status+reminder_sent_at+reminder_at` で scan (`src/db/repositories/sessions.ts:274-315`)
- schema には PK と `(weekKey, postponeCount)` unique のみ (`src/db/schema.ts:71-92`)
- 単一インスタンス + 4 人固定 + Neon pooler 最適化済 (`prepare:false`, `max:5`) で現実的な負荷はほぼゼロ。将来の長期累積対策
- **修正**: partial/composite index `(status, deadline_at)` と `(status, reminder_sent_at, reminder_at)` を追加 (migration 1 本)

### M2. Healthcheck ping 送信実装欠落 [TP1 F5 / TP4 F1 統合 / Medium]
- 宣言側 (env, README, ADR-0005, logger redact) は整備済、**送信関数ゼロ** (`src/scheduler/index.ts:226-254` に ping task なし)
- **修正**: 毎分 tick 内で `fetch(pingUrl, {method:'GET'})` + 5s timeout、undefined 時 no-op 維持、失敗 warn のみ
- Haiku critique 反映: TP1 F5 と TP4 F1 は同一 gap → 1 件化

### M3. startup recovery 1 session 失敗で全停止 [TA1 F1 / TP1 F4 / Medium]
- `runStartupRecovery` が 1 つの try/catch、per-session 分離なし
- `runDeadlineTick` も同 [TA6 F1]
- **修正**: postpone/reminder tick に揃えて per-session isolate

### M4. Dep graph の shared↔feature 双方向依存 [TA2 F1-F2 / TA7 F1 / Medium]
- `discord/shared/dispatcher.ts`, `guards.ts` が `features/interaction-reject/messages.ts` を参照。madge 実測 **4 循環 (全て dispatcher 起点)**
- **修正**: `InteractionHandlerDeps` と reject message catalog を `discord/shared/contracts` へ移動、feature → shared 片方向に

### M5. ingress 責務の揺れ [TA7 F2-F3 / Medium]
- defer 責任主体が handler ごとに不一致 (ask button は dispatcher 側 defer 前提、postpone/cancel は handler 側)
- cheap-first guard が dispatcher と handler 冒頭で重複、slash の `assertGuildAndChannel` は boolean 返しで reject 理由が潰れる (TS3 F1 と同根)
- **修正**: dispatcher を純粋ルータ化 + typed preflight API

### M6. Logger redact nested + raw error 露出 [TS2 F1-F3 / Medium]
- `logger.ts:9-26` の redact paths はトップレベル中心、`error.cause.headers.authorization` 等 nested は素通り。`scheduler/index.ts` 複数箇所で raw error を生出力
- `from/to/reason` 構造化ログも postpone-voting/cancel-week で不足
- **修正**: censor 併用 or nested path を列挙、state 遷移ログは全遷移で `from/to/reason` 必須化

### M7. fly.toml / Dockerfile 不在 [TP7 F1 / Medium] (Haiku critique で High → Medium)
- `ls` 実証済 (repo 直下に存在せず)
- autoscale / healthcheck / release_command / 単一インスタンス制約 / デプロイ禁止窓 / 非 root を repo で強制できず、全て Fly dashboard/README の手順に依存 = drift 源
- **修正**: `fly.toml` を commit し `[deploy] release_command` (migrate) / `auto_rollback` / `min_machines_running=1` / `vm_size` を明記。Dockerfile は README の buildpack 生成手順を採るなら不要だが方針選択は ADR 化

### M8. CI supply chain 強化 [TS5 F2 / TP7 F2 / Medium] (cluster critique で Medium に downgrade)
- GitHub Actions tag pin (SHA 未固定), `.mise.toml` `pnpm="latest"` 未 pin (CI は package.json で 10.33.0 固定なので**実害は local 開発のみ**)
- **修正**: action を commit SHA + Dependabot 対象化、`.mise.toml` `pnpm = "10.33.0"` 固定

### M9. Test 決定性 / Fake ports fidelity [TA3 F1 / TA4 F1-F2 / TA5 F4 / Medium] (C6)
- Fake ports が `new Date()` 直呼びで clock 注入が届かない
- integration が `createAppContext()`/`makeRealPorts()` を経由しない
- Fake held-events port が tx rollback/FK 未模倣
- **修正**: Fake ports にも ctx.clock を注入、contract test (real vs fake)、integration smoke を real ports 経由に

### M10. Perf hot path の重複 read [TP5 F4-F6 / Medium]
- startup recovery が CANCELLED を無駄読み
- decided path で session/responses/members を何度も読む
- reminder 2 段 read
- **修正**: fresh snapshot を pass、CANCELLED を non-terminal 集合から除外

### M11. 429 観測性ゼロ [TP6 F1 / Medium]
- discord.js 内部 retry 時の 429 情報 (route/bucket/retryAfter) が app log に出ない
- **修正**: `client.rest.on(RESTEvents.RateLimited, ...)` を購読し redact-safe で structured log

### M12. `/status` command 未実装 [Medium] (R9 で新規指摘)
- 仕様 (`requirements/base.md:205-206`) は `/status` を要件としているが、`src/commands/definitions.ts:3-10` には `/ask` と `/cancel_week` のみ
- 手動 runbook が C1/N1/H1 の対応として必須になるため、`/status` なしだと復旧補助コマンドがほぼ無い
- **修正**: 現在の週キー、ASKING/POSTPONE_VOTING/DECIDED session の状態、次の deadline/reminder 予定、reminder claim 状態を ephemeral で返す `/status` を追加

### M13. ADR-0007 vs requirements/base.md の spec drift [Medium] (R9 で新規指摘)
- ADR-0007 (`docs/adr/0007-ask-command-always-available-and-08-jst-cron.md:14-21,32`) は「金曜 ask cron を 18:00 JST から 08:00 JST に変更」を accepted status で決定済
- しかし canonical spec である `requirements/base.md:10,47-58,298` は 18:00 のまま。ADR-0007 自体が「requirements/base.md を更新する」と書いているが未反映
- **影響**: 将来レビューが再び「18:00 が canonical」と誤解し false drift を再発見。SSoT 原則 (ADR-0022) にも反する
- **修正**: `requirements/base.md` を ADR-0007 に揃えて 08:00 に更新し、ADR-0022 の SSoT 原則に沿った pointer コメントを追加

### Low / Info (抜粋)
- TA2 F3-F5: 健全系確認 (repositories→features 逆参照なし 等)
- TA7 F4-F5: router prefix literal / AppResult vs exception の層契約不揃い
- TA8 F1: `latestChoice` / `reminderAtFor` / `formatCandidateDateIso` 単体テスト欠落 (Haiku critique で一部 coverage 判明 → Low)
- TP1 F3: startup recovery N+1 (現規模許容)
- TP2 F1-F2: 境界時刻 inclusive は実装 OK、回帰 test 追加推奨
- TP5 F7: postgres.js statement timeout 未設定
- TP6 F2-F5: coalescing 不要 / interaction token 無観測
- TP7 F3-F4: tsconfig incremental / onlyBuiltDependencies
- TS1: gitleaks hit 2 件は test dummy (誤検知)
- TS2 F4-F5: console/process.env 直参照なし
- TS3 F1-F2: Slash reject 理由潰れ / sessionNotFound UUID 存在可否
- TS5 F3-F4: ubuntu-latest 固定 / dependabot/codeql 不在
- TS6: 0 件 (Haiku critique も confirm)

---

## 4. R7 Critique で追加された Residual Gaps

1. **デプロイポリシーが doc-only**: app-scoped token 利用 / デプロイ禁止窓 / 単一インスタンスを機械的に強制する checked-in workflow が存在しない (README と ADR-0005 の運用規律のみ)
2. **Fri 23:59 → Sat 00:00 JST の e2e scheduler/recovery テスト不在**: helper 層 (`tests/time/jst.test.ts`) と scheduler 層 (`tests/scheduler/deadline.test.ts`) は別々に境界をカバーしているが、両者を繋ぐ年跨ぎ + restart の統合 test がない
3. **ADR-0024 の受容条件が実装保証と乖離**: stale claim detector / warn / manual runbook の補償策が書かれていない (H3 修正と対になる)

---

## 5. Fix Sequencing (推奨)

| 優先 | 作業 | 解消する問題 | 対応 ADR |
|---|---|---|---|
| **P0** | Invariant-based startup reconciler (stranded CANCELLED / missing ask / stale reminder claim / askMessageId NULL / **deleted Discord message 検知** を 1 箇所で吸収) | C1 + N1 + H1 | ADR-0024 改訂 + 新 ADR (reconciler 仕様) |
| **P0** | `transitionStatus` 廃止 → edge-specific state API + 非終端集合再定義 (CANCELLED 除外) | C1 仕様乖離 + H3 任意遷移許容 | ADR-0001 更新 |
| **P0** | `/status` command 実装 (reconciler 動作確認と manual runbook の土台) | M12 + 全 P0 の観測性 | — |
| **P1** | DB transaction + outbox パターンで Friday cancel→postpone と ask publish を recoverable に (Discord 送信は atomic にならないため outbox + recoverable publisher) | C1 + N1 の永続化面 | ADR-0017 (存在すれば) 補足 or 新 ADR |
| **P1** | ready contract (phase+bootId) / ping 送信実装 / fly.toml commit を 1 セットで | M0 + M2 + M7 | ADR-0005 改訂 (SSoT + CI hardening 統合) |
| **P1** | `requirements/base.md` を ADR-0007 (08:00) に揃える spec drift 解消 | M13 | ADR-0007 反映作業 |
| **P2** | CI permissions 明示 → action SHA pin + `.mise.toml` pnpm pin | H2 + M8 | ADR-0005 改訂に統合 (独立 ADR 不要) |
| **P3** | Dep graph 整理 (shared ↔ feature 一方向化) + ingress 責務統一 + fake ports clock 注入 | M4 + M5 + M9 | ADR-0018 補足 |
| **P3** | sessions 期限系 composite index 追加 | M1 | migration のみ |
| **P3** | Logger nested redact + RateLimited 購読 + raw error catch 整備 | M6 + M11 | ADR-0019 (存在すれば) 補足 |

---

## 6. 観点別まとめ

### アーキテクチャ
- AppContext + ports パターン (ADR-0018) は概ね浸透、repository 直 import 0 件。**中核は健全**
- 状態機械 (TA5) と startup recovery (TA1/TA6) が最弱部。CANCELLED の扱いと edge-specific API 化が鍵
- dep graph は madge 実測 4 循環、全て dispatcher 起点 (TA2)。shared/feature 境界の再設計で解消可
- Time 層 (TA8) は ISO week / POSTPONE_DEADLINE 24:00 処理とも仕様準拠、健全

### パフォーマンス
- Hot path query 数は妥当 (ask button 6 queries, decision 発火時 +7〜12)。4 人規模では十分
- 真の perf 課題は **startup/毎分 tick の full-scan**。sessions 期限系 index 1 本 + recovery 継続性 fix が最大 ROI
- 送信量は cron fan-out 直列化 + noOverlap で抑制済、429 は **観測性がゼロ**だけが問題

### セキュリティ
- secret 漏えい経路: 実害ゼロ (tracked 全ファイル gitleaks clean, `DIRECT_URL` は drizzle.config.ts 限定、redact 網羅)
- 入力検証: cheap-first guard + zod narrow + DB 再取得は主経路で完備 (TS3)、tamper 起因の状態改変経路なし
- SQL: `sql.raw()` 未使用、unique / CHECK / FK CASCADE 完備、atomicity 欠落 (TS4 F1/F2) は **セキュリティでなく integrity 問題として H3/N1 に吸収**
- CI/supply chain: permissions 明示と SHA pin は要対応、deploy token 運用は ADR/README で規律化済だが機械強制なし

---

## 7. ADR 改訂提案 (新規/更新候補)

| 対象 | 種別 | 内容 |
|---|---|---|
| ADR-0001 (状態機械) | **更新** | CANCELLED を中間限定として再定義、edge-specific 遷移 API を列挙、土曜中止/順延 NG/未完は COMPLETED へ |
| ADR-0005 (運用ポリシー) | **更新** | ready contract の phase 定義、fly.toml SSoT 化、ping 送信実装と no-op 条件を明文化 |
| ADR-0018 (DI) | **補足** | Fake ports にも ctx.clock を浸透させる rule、integration は createAppContext 経由必須 |
| ADR-0024 (reminder dispatch) | **更新** | 残余リスク受容条件 + stale-claim 補償策 (detector / warn / runbook) を明記 |
| ADR-0007 (ask 時刻 08:00) | **反映作業** | `requirements/base.md` を ADR-0007 に揃える (ADR 自体は accepted、spec 側が未追従) |
| 新 ADR | **新規** | Startup invariant reconciler 仕様 (C1 + N1 + H1 を統合解決、deleted Discord message 検知を含む) |
| ~~新 ADR: CI hardening~~ | ~~新規~~ | **R9 により不要判定**: ADR-0005 更新に統合 (単独の architecture decision でなく repo config + ops policy の範疇) |

---

## 8. 矛盾 / 見かけ上の二重指摘

- **矛盾なし**。cluster critique で訂正済
- 見かけ上: TA5 F1 (High, 仕様破綻面) vs TS4 F1 (Medium, 機構要因面) は同一現象の別評価 → C1 Critical に統合
- TP1 F5 vs TP4 F1 は同一 gap (Haiku critique で独立 cross-verify) → M2 に 1 件化

---

## 9. レビュー対象外 / Unknown

- 本番 Neon の EXPLAIN / pg_stat_statements (実測値なし、推定のみ)
- GitHub Actions Secrets 実効内容 (repo 外)
- Branch protection / required checks 設定
- fly.io dashboard 側の VM size / autoscale / healthcheck / 非root 設定 (repo 外)
- Healthchecks.io 側の alert rule
- Copilot coding agent 自体の workflow (別経路)

---

## 付録: Finding 一覧索引

- Architecture: TA1 (startup) / TA2 (dep graph) / TA3 (ports boundary) / TA4 (test infra) / TA5 (state machine) / TA6 (module state + cron) / TA7 (ingress) / TA8 (time + pure domain)
- Performance: TP1 (boot-to-ready) / TP2 (time boundaries) / TP3 (reminder stuck) / TP4 (healthcheck drift) / TP5 (DB query perf) / TP6 (Discord rate-limit) / TP7 (CI/build/runtime hygiene)
- Security: TS1 (gitleaks) / TS2 (redaction) / TS3 (interaction trust) / TS4 (DB integrity) / TS5 (CI supply chain) / TS6 (ops credential hygiene)
- R7 critiques: r7-cluster-critique.md (GPT-5.4, cluster verdict + N1 新発見) / r7-haiku-critique.md (GPT-5.4, TP4/TA8/TP7/TS6 後段)
