# Summit アプリケーション全体レビュー計画

## 1. 問題提起 / アプローチ

summit は固定 4 名の桃鉄 1 年勝負の出欠自動化を担う個人開発 Discord Bot。Fly.io 単一インスタンス、Neon PostgreSQL、discord.js v14、node-cron、pino、zod、Drizzle、neverthrow を中心に、DB 正本 + AppContext/ports DI + 時刻層集約 + CAS 状態遷移が要の構造。

ユーザー要件は **Architecture / Performance / Security** の 3 大観点で包括的レビューを subagent 並列で実施。各観点ごとに (a) ブレスト (b) セカンドオピニオン (c) 統合を済ませた。この plan.md は統合結果として、**最終レビュー観点・評価方法・単純化されたタスク・推奨モデル** を定義する。

### 方針
- **実装はしない**（レビュー計画のみ）。ADR / AGENTS.md / requirements/base.md / review instructions を SSoT として扱い、drift を監査する。
- **並列度は最大 4**、各観点 3〜5 タスクに分解して fleet 実行可能にする。
- **セカンドオピニオンは観点ごと + 計画全体** で必ず取る（既完了: 観点別 3 件、残: 統合計画全体 1 件）。
- モデル配分:
  - **Haiku 4.5**: 単純 grep / drift 検出 / チェックリスト監査（必ず GPT-5.4/GPT-5.3-Codex のレビュー付き）
  - **GPT-5.3-Codex High**: メイン実装レビュー（DB / interaction / logging の code-path 精読）
  - **GPT-5.4 High**: コード調査、タスク調停、境界レビュー、統合
  - **Opus 4.7**: 全体統合、クリティカルな最終判断（main agent 自身）

### 成果物の形
各タスクの期待出力は、**「判定表 / 観点別 findings 一覧 / 根拠 (file:line) / 推奨度 (High/Medium/Low)」**。レビュー自体はコード変更を伴わない。

## 2. レビュー観点（統合後）

### A. Architecture (8 観点)
Phase 1 で 20+3、Phase 2 second opinion で 14 に再集約。High に絞るため以下 8 観点に統合。

| ID | 観点 | 主な懐疑ポイント | 優先度 |
|---|---|---|---|
| A1 | Composition root / runtime lifecycle | startup/shutdown ordering (`scheduler stop → drain → DB close → client destroy`)、signal handler idempotency、Client singleton lifetime、bootstrap の副作用が `index.ts` に集約されているか | High |
| A2 | モジュール境界 & 依存グラフ | features/shared/db/scheduler/time の ownership、reject-interaction taxonomy、循環依存 | High |
| A3 | DI & AppContext 境界 | handlers/workflows が `ctx.ports.*` / `ctx.clock` 経由か、Client を AppContext に入れない設計、test の fake ports fidelity | High |
| A4 | テスト基盤 (`tests/testing/`) | createTestAppContext 普及率、fake/real ports drift、vi.mock 回帰防止 | High |
| A5 | 状態変更アーキテクチャ + HeldEvent atomicity | `transitionStatus` / `skipSession` / `claimReminderDispatch` / `completeDecidedSessionAsHeld` の全列挙、仕様外遷移、`COMPLETED without HeldEvent` race、participants 出典 | High |
| A6 | Scheduler & DB-as-SoT | in-memory state 禁止範囲の棚卸し、tick 冪等、startup recovery 経路、node-cron 多重登録防止 | High |
| A7 | Interaction ingress boundary | defer-first、cheap-first 順、custom_id zod narrow、dispatcher / guards / reject ownership | High |
| A8 | Time architecture & pure domain purity | `src/time/**` への集約、ISO week + year 併用、`POSTPONE_DEADLINE` 境界、`slot.ts` の依存ゼロ・副作用ゼロ | High |

補助観点（Medium/Low、task には含めるが軽量監査）:
- DB boundary / migration safety (DIRECT_URL 分離, generate+migrate 強制)
- Observability gaps (transition log の from/to/reason、redact 漏れ)
- docs / ADR / requirements drift

### B. Performance (4 High + 補助)
Phase 2 で 11 に圧縮。High は「運用事故に直結する 4 つ」に再集中。

| ID | 観点 | 主な懐疑ポイント | 優先度 |
|---|---|---|---|
| P1 | 起動フェーズ / restart recovery | `process start → login → reconcileMembers → startup recovery → scheduler registration` の boot-to-ready、missed-window recovery 完全性、ダウン窓の許容 | High |
| P2 | 時刻境界 drift | 21:30 / 23:59→00:00 JST handoff / year-boundary で skip/execute がずれないか、`node-cron` 境界 test 不足 | High |
| P3 | Reminder claim / stuck | ADR-0024 既知リスク。claim 後 crash で `DECIDED + reminder_sent_at!=NULL` の stuck、検知・復旧手順 | High |
| P4 | Healthcheck / observability drift | `HEALTHCHECK_PING_URL` env/README 宣言済みだが実装欠如疑義、ping no-op 分岐の正しさ、ping 失敗の影響範囲 | High |
| P5 | DB I/O path | button 1 回あたり query 数、pool max=5 での 4 concurrent 飽和、主要 SELECT の EXPLAIN (`findDue*Sessions`, `findNonTerminalSessions`) | Medium |
| P6 | Discord 429 / back-pressure | discord.js internal retry 任せで十分か、rate-limit 発生の observability | Medium |
| P7 | HeldEvent tx cost / CI install latency / migrate runtime | tx 時間見積り、CI `pnpm install` 3 jobs 重複、release_command 所要 | Medium-Low |

### C. Security (6 観点)
Phase 2 で 10 に圧縮。主要 6 に統合。

| ID | 観点 | 主な脅威 | 優先度 |
|---|---|---|---|
| S1 | Secrets footprint & history | tracked (`*.bak` 含む) / ignored / untracked / **full-git-history** の実値 secret 混入 | High |
| S2 | Logging & telemetry redaction | token / 接続文字列 / Authorization / interaction payload 全量ログの有無、`pino redact` 設定 | High |
| S3 | Interaction trust boundary | cheap-first 順、custom_id tamper、非 member 押下、stale/dispatcher bypass、reject 文言の情報漏洩、slash guild-scope 徹底 | High |
| S4 | DB & state integrity | race / double submit / `(sessionId, memberId)` unique / tx scope / dynamic SQL 無 / `sql.raw` 危険入力無 | High |
| S5 | CI / workflow / shell guardrails | `permissions:` 最小化、shell-obfuscation pattern (`${var@P}` `${!var}` `eval`) 検査、`verify:forbidden` の網羅性 | Medium |
| S6 | Ops credential hygiene | Fly deploy token scope、SSH/root 分離、Neon role rotation、Discord webhook inventory | Medium |

補助: Env fail-fast 再確認 / Supply chain (frozen-lockfile, minimum-release-age, Dependabot) / HMAC/webhook/dist/placeholder 再評価 (Low)。

## 3. 評価方法

観点ごとに (i) 対象ファイル・シンボル (ii) 補助 grep (iii) 判定基準 (iv) 期待出力 を明示。一般論として:

- **CI 自動化対象 (diff-level)**: forbidden pattern (既存 `scripts/verify/forbidden-patterns.sh`)、`new Date()` / `process.env` 直参照 / `sql.raw` / `drizzle-kit push` / backup 拡張子 tracked / shell-obfuscation。
- **CI 自動化候補 (追加提案)**: gitleaks diff, `${var@P}` / `${!var}` / `eval` の shell security pattern, workflow `permissions:` 明示。
- **手動精読向き**: shutdown ordering、HeldEvent atomicity、Client singleton lifetime、fake-ports fidelity、reject taxonomy、reminder claim stuck、時刻境界 drift。
- **定量計測 (軽量)**: structured log 時刻差 (boot-to-ready)、query count、対象 SQL の EXPLAIN ANALYZE、mocked 429 レイテンシ、GHA step duration。
- **ツール**: ripgrep、Drizzle symbol overview、madge（循環依存）、gitleaks (full history)。`trufflehog` は任意。

## 4. タスク分解（fleet 実行用）

単純化の原則:
- 1 タスク = 1 観点 = 1 subagent invocation、対象ファイル最大 ~10、2h 以内で完結。
- すべてのレビュータスクは「観点別 findings + 根拠 file:line + 推奨度」を出力。
- Haiku タスクは必ず GPT-5.4 もしくは GPT-5.3-Codex の review を後段に 1 回挟む。

### Architecture tasks (8)

| Task | 対象 | 推奨モデル | セカンドオピニオン |
|---|---|---|---|
| TA1 | composition root: `src/index.ts`, `src/shutdown.ts`, `src/scheduler/index.ts`, `src/discord/client.ts`, `src/db/client.ts`, `src/features/ask-session/send.ts` (Client 利用側)、shutdown tests | GPT-5.4 | GPT-5.3-Codex |
| TA2 | dep graph: 全 `src/**` import graph + madge + reject-interaction taxonomy | GPT-5.3-Codex | GPT-5.4 |
| TA3 | DI boundary: `src/appContext.ts`, `src/db/ports.ts`, `src/db/ports.real.ts`, handler call-sites + forbidden direct `db/repositories` grep | GPT-5.4 | GPT-5.3-Codex |
| TA4 | test infra: `tests/testing/**` + 本番側 `src/appContext.ts` / `src/db/ports.real.ts` を対比、usage map、vi.mock 棚卸し | GPT-5.4 | GPT-5.3-Codex |
| TA5 | state machine + HeldEvent atomic path: `transitionStatus` / `skipSession` / `claimReminderDispatch` / `completeDecidedSessionAsHeld` を全列挙。**必須対象**: `src/db/repositories/heldEvents.ts`, `src/features/reminder/send.ts`, `src/db/repositories/sessions.ts`, `tests/testing/ports.ts` | GPT-5.4 | GPT-5.3-Codex（Opus は R8 全体統合で再評価） |
| TA6 | scheduler DB-as-SoT: scheduler + features の module-level state grep、startup recovery 読解 | GPT-5.3-Codex | GPT-5.4 |
| TA7 | interaction ingress **層境界/責務分担**: dispatcher/guards/customId/button/command path の責務分離・ownership 評価（tamper/非 member は TS3 側） | GPT-5.4 | GPT-5.3-Codex |
| TA8 | time + pure domain: `src/time/**`, `src/slot.ts`, forbidden `new Date()` 監査 | Haiku 4.5 | GPT-5.4（必須） |

補助 (Haiku+review 付き 1 バッチで): DB migration safety, observability gaps, docs/ADR drift.

### Performance tasks (4 High + 3 batch)

| Task | 対象 | 推奨モデル | セカンドオピニオン |
|---|---|---|---|
| TP1 | boot-to-ready: `src/index.ts`, `src/scheduler/index.ts`, README deploy, structured log 指針。**TA1 と密結合のため Phase R1 で TA1 と並列実行または直後に配置** | GPT-5.4 | GPT-5.3-Codex |
| TP2 | time boundary drift: `src/config.ts`, `src/time/**`, scheduler tests, year/midnight cases | GPT-5.4 | GPT-5.3-Codex（Opus は R8 全体統合で再評価） |
| TP3 | reminder stuck: ADR-0024 + reminder send flow + claim semantics、障害注入シナリオ | GPT-5.4 | GPT-5.3-Codex |
| TP4 | healthcheck drift: `src/env.ts`, `src/logger.ts`, README healthcheck、**repo-wide rg (`HEALTHCHECK_PING_URL\|healthcheck\|ping`) で実装/宣言差分を機械的に抽出** | Haiku 4.5 | GPT-5.4 |
| TP5 | DB I/O 観点 (perf 側): `src/db/client.ts`, `src/db/repositories/sessions.ts`, button handlers; 4 concurrent 試算 + EXPLAIN 対象列挙。**HeldEvent tx 時間/lock scope は TA5 に委譲、本タスクは I/O budget に集中**。TS4 との重複を避けるため **TS4 より後 (R5 以降) に配置** | GPT-5.4 | GPT-5.3-Codex |
| TP6 | 429 back-pressure: dispatcher + send 層 review, rate-limit log 観測点 | GPT-5.4 | GPT-5.4-mini |
| TP7 (batch) | CI install / migrate runtime / build-cache / runtime overhead hygiene | Haiku 4.5 | GPT-5.4 |

### Security tasks (6)

| Task | 対象 | 推奨モデル | セカンドオピニオン |
|---|---|---|---|
| TS1 | secrets footprint + history: tracked/ignored/untracked + gitleaks full history。**期待出力は redacted path / fingerprint のみで、実値・疑い値を出力に含めない** (secrets-review.instructions 準拠)。positive hit 時のみ Opus で再評価 | GPT-5.3-Codex + gitleaks | GPT-5.4（Opus は hit 時のみ） |
| TS2 | logging redaction: logger config + call-site サンプリング + payload field inventory | GPT-5.3-Codex | GPT-5.4 |
| TS3 | interaction trust boundary **tamper / 非 member / stale / information leak**: guards/dispatcher/customId/button handler + reject 文言 の攻撃耐性（責務分担は TA7 側） | GPT-5.3-Codex | GPT-5.4 |
| TS4 | DB/state integrity: repositories + workflows + scheduler、CAS/unique/tx/dynamic SQL。**TP5 より先に実行し、findings を TP5 に提供** | GPT-5.3-Codex | GPT-5.4 |
| TS5 | CI/workflow/shell guardrails: `.github/workflows/ci.yml`, `scripts/verify/*`, shell-obfuscation pattern 追加提案 | GPT-5.3-Codex | GPT-5.4 |
| TS6 | ops credential hygiene: README, ADR-0005/運用 ADR, Fly/Neon/Discord の手動監査項目列挙 | Haiku 4.5 | GPT-5.4 |

補助 (Haiku+review 1 バッチ): env fail-fast 再確認 / supply chain (frozen-lockfile, minimum-release-age, Dependabot) / HMAC/webhook/dist/placeholder 再評価。

## 5. 実行フェーズと順序

依存関係に基づく並列最適化 (同じ面を同時に読ませない / 依存は直列化):

1. **Phase R1 (並列 4): 起動・状態機械・時刻・secrets の High** — TA1, TA5, TP2, TS1
2. **Phase R2 (並列 4): boot/reminder/trust/redaction** — TP1, TP3, TS2, TS3 (※TA7 は R3 へ回して TS3 と同じ面の同時精読を回避)
3. **Phase R3 (並列 4): 境界/DI/DB integrity** — TA3, TA6, TA7, TS4
4. **Phase R4 (並列 4): test infra + dep graph + healthcheck + 429** — TA4, TA2, TP4, TP6
5. **Phase R5 (並列 3): perf I/O と補助** — TP5 (TS4 の findings を入力に), TA8, TP7
6. **Phase R6 (並列 3): CI/ops + 補助バッチ** — TS5, TS6, 補助バッチ（arch/perf/sec の Low-Medium まとめ）
7. **Phase R7: 観点別セカンドオピニオン** — 各タスクの sister review を並列最大 4 で起動。TP6 は GPT-5.4-mini で軽量レビュー
8. **Phase R8: Opus 4.7 全体統合** — 全 findings を Opus が読み、High/Critical 抜粋 + TS1 positive hit / TA5 atomic violation の再評価 → 最終レポート作成
9. **Phase R9: 最終セカンドオピニオン** — 統合レポートへの critique を GPT-5.4 に 1 回

## 6. 注意事項・制約

- **本番 DB / デプロイ禁止窓 / secrets 実値**: ルール上、レビュー中も実行しない・触れない・露出しない。
- **レビューはコード変更を伴わない**。findings に修正案があっても実装は別 PR。
- **plan.md 内に実行値を写さない**（ADR-0022 SSoT）。cron 式や閾値は `src/config.ts` を参照する形で findings にポインタを書く。
- **モデル代替**: ユーザー指定の "Gemini 3.1 Pro" は available_models に不在のため、セカンドオピニオンは GPT-5.4 High を代替採用済み（ユーザーに事前明示）。
- **Haiku 使用時は必ず GPT-5.4 もしくは GPT-5.3-Codex のレビューを後段に挟む**（ユーザー要件）。
- **gitleaks を使うタスク (TS1)** は repo ローカル実行のみ、結果は session files/ に格納し PR/コミットに含めない。

## 7. 次アクション（ユーザー承認待ち）

この plan.md への critique を Phase 4 として GPT-5.4 から得たうえで、ユーザーに以下確認:
- 本計画のまま実行開始してよいか
- モデル代替（Gemini → GPT-5.4）で問題ないか
- 補助観点（Medium-Low）まで全部実行するか、High のみに絞るか
