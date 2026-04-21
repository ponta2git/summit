# R9 Final Critique (GPT-5.4 rubber-duck)

対象: `files/final-report.md` (R8 統合版) の最終セカンドオピニオン。

## 1. Severity calibration
- **C1 は方向正しいが wording は「その週が失われる」**: 翌週は新 `weekKey` で継続 (`src/time/index.ts:39-45`, `src/features/ask-session/send.ts:51-57`, `src/db/schema.ts:72-79`)。「bot stops」は過剰
- **N1 Near-Critical は妥当**: recovery は existing non-terminal のみ処理、missing ask 合成 / `askMessageId=NULL` 修復 不可 (`src/scheduler/index.ts:166-209`)
- **H5 (index 不在) は Medium に下げるべき**: single-instance + Neon pooler 設定済 (`src/db/client.ts:7-18`) → 最適化
- **H1 (ready log) も Medium 相当**: string 自体で週を落とすわけではない
- **H4 (CI permissions) は borderline High/Medium**: test/build-only で write step なし

## 2. Missing issues
- **削除された Discord message の recovery gap (High 相当)**: ask/postpone message を誰かが削除すると DB 健全、`/ask` スキップ、editor は warn のみ、recovery は Discord 存在確認しない (`src/features/ask-session/send.ts:57-75`, `src/features/ask-session/messageEditor.ts:15-31`, `src/features/postpone-voting/messageEditor.ts:17-37`) → **N1 統合推奨**
- **ADR-0007 vs requirements/base.md drift**: ADR-0007 は 08:00 に accepted (`docs/adr/0007-ask-command-always-available-and-08-jst-cron.md:14-21,32`) だが `requirements/base.md:10,47-58,298` は 18:00 のまま → ADR 計画に追加必須
- **`/status` 未実装**: 仕様 (`requirements/base.md:205-206`) は `/status` 要件、`src/commands/definitions.ts:3-10` には `/ask` と `/cancel_week` のみ → 手動 runbook が C1/N1 対応に必要なので Medium 追加
- **Neon pooler 追加課題なし**: `prepare:false`/`max:5`/timeouts 済 → 既知対応済
- **interaction-token 15min 課題なし**: 全 handler で即時 ack 確認済

## 3. Fix sequencing correctness
- **P0 before P1 は正しい**: Friday atomic rewrite では stranded CANCELLED / 土曜 cancel terminal misuse / postpone-NG が CANCELLED 止まりを解決できない
- **P1 の "1 transaction / outbox" 表現を tighten**: Discord 送信は Postgres と atomic にならない。正しくは **DB transaction + outbox + recoverable publisher**

## 4. C1 framing check
- **検証 OK だが wording 修正必要**: 同週の recovery は `(weekKey, postponeCount=0)` row の unique でブロック、CANCELLED 分岐なし → 該当週は失われる。**翌週は新 `weekKey` で継続される**ので「bot stops」は不正確

## 5. N1 framing check
- **検証 OK**: `runStartupRecovery` は overdue ASKING / overdue POSTPONE_VOTING / due DECIDED reminder のみ、missing current-week ask 合成なし、`askMessageId` gap 修復なし (`src/scheduler/index.ts:166-209`)

## 6. ADR proposal coverage
- **欠落**: ADR-0007 と `requirements/base.md` の drift 解消を計画に含めるべき
- **"CI hardening ADR" は不要**: ADR-0005 更新 or repo config 範疇、独立 ADR 不要
- **Startup invariant reconciler ADR は妥当**: runtime behavior contract として独立 ADR 化の価値あり

## 7. Anything else
- Downgrade: H5 → Medium
- Possibly downgrade: H1, H4 を 1 段
- Escalate/add: deleted-message recovery gap を N1 に明示統合
- Add to plan: 08:00 vs 18:00 spec drift 解消 / `/status` 欠如を omitted requirement gap として記載

## 総合
R8 の核 (C1/N1/P0) 診断は strong。主要修正は **(a) C1 wording を "週が失われる" に tighten、(b) deleted-message / message-existence recovery gap を明示、(c) 08:00 vs 18:00 spec drift を ADR/doc remediation に含める**、の 3 点。

## 反映状況 (main agent による R9 → final-report v2)
- ✅ C1 wording 修正 (「bot stops」→「該当週が失われる」、翌週 `weekKey` 継続を明記)
- ✅ N1 に deleted Discord message recovery gap を統合
- ✅ H5 → M1 に降格
- ✅ H1 → M0 に降格
- ✅ H4 は High 維持 (対応コスト極小で即対応が妥当)
- ✅ M12 `/status` 未実装 を新規追加
- ✅ M13 ADR-0007 vs requirements/base.md drift を新規追加
- ✅ P1 "1 transaction / outbox" → "DB transaction + outbox + recoverable publisher" に tighten
- ✅ P0 reconciler に deleted Discord message 検知を明示追加
- ✅ P0 に `/status` 実装を追加
- ✅ P1 に spec drift 解消を追加
- ✅ CI hardening 独立 ADR → ADR-0005 統合に変更
