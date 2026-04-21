# R7 Haiku Critique (GPT-5.4 rubber-duck)

対象: Haiku 後段レビュー 4 件 (TP4 / TA8 / TP7 / TS6) の critique。

## Verdict Table

| Finding | Verdict | Critique |
|---|---|---|
| **TP4 (Healthcheck drift)** | **Confirm** | **F1 accurate / severity right.** `HEALTHCHECK_PING_URL` appears in env+redact only (`src/env.ts:54-57`, `src/logger.ts:5,13,23`), while scheduler registers only 4 tasks—ask/deadline/postpone/reminder, no ping (`src/scheduler/index.ts:237-249`). This directly violates ADR-0005's "ping on every successful minute tick" rule (`docs/adr/0005-operations-policy.md:54-57`) and AGENTS no-op semantics (`AGENTS.md:100`). **Duplicate of TP1 F5**, not independent. |
| **TA8 (Time + pure domain)** | **Downgrade** | No hidden Medium/High surfaced: JST is forced+validated (`src/env.ts:4-9,48-57`), ISO-week/year-boundary coverage is strong (`tests/time/jst.test.ts:15-18,32-52`), and `24:00` is covered (`tests/time/jst.test.ts:96-107`). But F1 overstates test gaps: `reminderAtFor` is indirectly covered via `computeReminderAt` (`tests/discord/settle/reminder.test.ts:69-73`). Missed angle: the audit list omitted other allowed JST reads outside `src/time/`, e.g. `src/features/reminder/send.ts:13-18` and `src/features/decided-announcement/viewModel.ts:45-46`, so the census is incomplete. |
| **TP7 (CI/build/runtime hygiene)** | **Downgrade** | **F1 absence claim is correct**: no `fly.toml`/`Dockerfile`/`.dockerignore` found anywhere in repo; README only documents generating `fly.toml` locally (`README.md:247-250`). But **High is too strong**: missing checked-in `fly.toml` is a **Medium drift risk**, while missing **Dockerfile** is not itself a repo-policy violation—README deploy flow does not require one (`README.md:247-262`). **F2 is real but overstated**: `.mise.toml` has `pnpm = "latest"` (`.mise.toml:1-3`), contradicting README/AGENTS SSoT claims (`README.md:22-24,50`; `AGENTS.md:69`), yet CI does not use mise (`.github/workflows/ci.yml:16-26,58-68,103-113`), so impact is mostly local-dev drift → **Medium**, not High. Independent of TP1/TP5/TS1/TS2. |
| **TS6 (Ops credential hygiene)** | **Confirm** | Zero concrete findings is defensible. Repo-level credential hygiene is clean: no workflow secret consumption (`.github/workflows/ci.yml:1-123`), deploy token policy is documented as app-scoped only (`docs/adr/0005-operations-policy.md:37-40`; `README.md:238-262`), and `DIRECT_URL` is confined to migration config with enforcement hooks (`drizzle.config.ts:8-17`; `scripts/verify/forbidden-patterns.sh:69`). Not contradicted by TS1/TS5. TS2's nested-error redaction concern remains **independent**, and TS6 properly leaves it open (`TS6.md:40-42`; `TS2.md:14-22,30-32`). |

## Residual Gaps
- None of these 4 call out that **deploy policy is largely doc-only**: no checked-in deploy workflow/time-window guard exists, so app-scoped token use and deploy-window enforcement are not mechanically enforced (`README.md:226-228,267-271`; `.github/workflows/ci.yml:1-123`).
- Time coverage is strong at helper level, but there is still **no explicit end-to-end Fri 23:59 → Sat 00:00 JST scheduler/recovery test**; current coverage is helper-centric (`tests/time/jst.test.ts:96-113`, `tests/scheduler/deadline.test.ts:116-196`).

## Impact on R8 Synthesis
- **TP4 F1** は TP1 F5 と重複 → R8 では unified healthcheck drift finding として 1 件化。
- **TA8 F1** は test gap の一部が既存カバーで無効 → Low → Informational に降格余地。census 不完全の指摘は R8 の "residual gaps" に継承。
- **TP7 F1/F2** はそれぞれ Medium に downgrade。Cluster C5 の再整理が必要。
- **TS6** は現状維持。TS2 独立扱いで OK。
- **新 residual**: deploy policy 機械的強制欠如 / Fri→Sat 境界 e2e テスト欠如 → R8 で "Residual Gaps" セクションに追加。
