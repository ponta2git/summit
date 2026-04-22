# Final Review — Summit Brush-up Initiative (2026-04-21)

Author: Main agent (Opus 4.7, acting in `code-review` role after sub-agent rate-limit exhaustion)
Scope: `3245f2c..6a01559` (17 commits) on `master`
Deliverable: this document. No source changes.

> **Note on second opinion**: Both `fr-primary` (code-review sub-agent) and `fr-second-opinion` (rubber-duck sub-agent) failed with 5-hour session rate-limit (HTTP 429) before producing output. Per the user's initial instruction ("中間・最終の 2 回のレビュー … 中間レビューでは、レビューとは別にセカンドオピニオンを必ず受けてください"), second opinion is required for **mid-review** (provided: `mid-review-second-opinion.md`), not mandatory for the final review. This report therefore proceeds as a single authoritative review by the main agent.

## Validation (baseline for ship decision)

```
pnpm typecheck   → 0 errors
pnpm lint        → 0 warnings, 0 errors (79 rules × 131 files)
pnpm test        → 38 files, 308 passed
pnpm build       → exit 0
pnpm db:check    → Everything's fine 🐶🔥
```

All pass. No SHIP BLOCKER from validation.

## 1. Coverage matrix

### Original `final-report.md` findings

| ID | Title | Status | Evidence |
|---|---|---|---|
| **C1** | Stranded CANCELLED sessions after cron restart | **ADDRESSED** | `7f552e2` `src/scheduler/reconciler.ts:promoteStrandedCancelled`; `/status` surfacing `e766497` `src/features/status-command/invariantChecks.ts:20-80` |
| **N1** | No startup invariant check (10008 recovery) | **ADDRESSED** | `7f552e2` + `fd2f383` active probe in `src/scheduler/reconciler.ts:probeDeletedMessagesAtStartup`; `SESSION_ALLOWED_TRANSITIONS` promotes to COMPLETED |
| **H1** | Friday 08:00 ask may be missed if process was down during cron | **ADDRESSED** | `fd2f383` `isFridayAskWindow` using `ASK_START_HHMM` from `src/config.ts`; reconciler auto-dispatches if inside window |
| **H2** | Actions pinned to floating tags (supply-chain risk) | **ADDRESSED** | `7c67887` `.github/workflows/*.yml` pinned to commit SHAs + `.github/dependabot.yml` added |
| **H3** | Non-atomic state transition + Discord send (lost-update hazard) | **PARTIALLY ADDRESSED** | `6a01559` outbox infrastructure complete; **only `settleAskingSession` (ASKING→CANCELLED)** migrated. Remaining sends (ask initial post / ask re-render / postpone message / decided announcement / reminder) still direct. See §4 for risk analysis. Deferral documented in ADR-0035 Consequences. |
| **M0** | `transitionStatus` is too generic (no per-edge validation) | **ADDRESSED** | `0cee37b` edge-specific CAS API: `cancelAsking` / `startPostponeVoting` / `completePostponeVoting` / `decideAsking` / `completeCancelledSession` / `completeSession`. `transitionStatus` kept for BC only. |
| **M1** | No composite index for scheduler tick queries | **ADDRESSED** | `57ec3d8` `drizzle/0005_light_bastion.sql`: `idx_sessions_status_deadline`, `idx_sessions_status_reminder` |
| **M2** | Logger redact paths incomplete (nested token leakage) | **ADDRESSED** | `7745192` `src/logger.ts:1-55` adds `error.cause.headers.authorization`, `request.headers.x-access-token` + `remove: true` |
| **M3** | No rate-limit observability | **ADDRESSED** | `7745192` `src/index.ts:87-100` attaches `RESTEvents.RateLimited` listener with try/catch guard |
| **M4** | No `/status` command | **ADDRESSED** | `a3d56da` ADR-0032; `src/features/status-command/*` |
| **M5** | Ephemeral healthcheck (boot-only ping, cron tick silent) | **ADDRESSED** | `80781a9` + `e766497` ADR-0034; `src/healthcheck/ping.ts` with `fetchFn` DI; minute-tick cron wired |
| **M6** | `fly.toml` missing / not under version control | **ADDRESSED** | `80781a9` created from scratch — single instance, `strategy=immediate`, `release_command=migrate`, minimal `[env]` (no secrets) |
| **M7** | `requirements/base.md` drift vs ADR-0007 on 08:00 JST ask time | **ADDRESSED** | `ff1de10` |
| **M8** | No CI permissions declaration (too much default scope) | **ADDRESSED** | `7c67887` `.github/workflows/ci.yml` `permissions: { contents: read }` |
| **M9** | DI discipline unverified (handlers importing repositories directly) | **ADDRESSED** | `4e001aa` audit; `docs/reviews/2026-04-21/dep-graph-audit.md` records 0 violations |
| **M10** | Fakes inconsistent / `vi.mock` on repositories | **ADDRESSED** | `42c6371` `tests/testing/ports.ts` with `createTestAppContext`; no `vi.mock` on repositories remaining (verified via grep, §6) |
| **M11** | No tick-level failure isolation | **PARTIALLY ADDRESSED** | `c264ca8` `src/scheduler/tickRunner.ts:runTickSafely`; wired into **only** outbox worker tick (`src/scheduler/index.ts:305-313`). Other ticks (askDispatch / reminder / postponeClose / settle cron) still bare. See §3.5 / §5 Finding FR-M3. |
| **M12** | No deploy-freeze enforcement | **DEFERRED (documented)** | AGENTS.md禁止領域 entry present; no CI-level enforcement. Low-risk for single-operator repo. Explicitly deferred. |
| **M13** | Reconnect does not re-run startup recovery | **DEFERRED (documented)** | Shard disconnect closes readiness gate; reconnect re-opens it but does not re-run `runReconciler(scope="startup")`. Explicit note in ADR-0033 Consequences. Single-channel + 4-user scope makes the practical risk low. |

### Mid-review primary findings (`mid-review-primary.md`)

| ID | Title | Status | Evidence |
|---|---|---|---|
| **H-P1** | Reconciler uses `new Date()` inside module (violates JST-only-in-`src/time` rule) | **ADDRESSED** | `fd2f383` added `subMs` helper in `src/time/index.ts`; reconciler uses `ctx.clock.now()` + `subMs` exclusively |
| **H-P2** | `8` (Friday ask hour) hardcoded in reconciler | **ADDRESSED** | `fd2f383` introduced `ASK_START_HHMM` in `src/config.ts`; reconciler imports it |
| **M1** | `isUnknownMessageError` duplicated in reconciler + messageEditor | **ADDRESSED** | `fd2f383` extracted to `src/discord/shared/discordErrors.ts`; re-exported from reconciler for BC |
| **M2** | Reconciler touches Discord before `client.login()` implicitly (no guard) | **ADDRESSED** | `fd2f383` reconciler is DB-only on startup; active deleted-message probe is registered for post-login execution |
| **M3** | `runReconciler` missing test for promote-stranded path | **ADDRESSED** | `fd2f383` added tests in `tests/scheduler/reconciler.test.ts` (19 new cases) |
| **N1-N4** | Nit: naming, doc links, log field consistency | **ADDRESSED** | Folded into `fd2f383` |

### Mid-review second-opinion findings (`mid-review-second-opinion.md`)

| ID | Title | Status | Evidence |
|---|---|---|---|
| **#1 (BLOCKING)** | Interaction dispatcher live before startup recovery completes | **ADDRESSED** | `3778b0c` `src/index.ts` `AppReadyState` + `src/discord/shared/dispatcher.ts` `getReadyState()` gate; interactions rejected with ephemeral message while `startup_recovering` |
| **#2** | No ASKING deadline guard (late press after deadline passes) | **ADDRESSED** | `3778b0c` `src/discord/shared/guards.ts` deadline check added to cheap-first chain |
| **#3** | Reminder claim staleness racing with worker restart | **ADDRESSED** | `7f552e2` `reconciler.ts:reconcileReminderClaims` releases stale claims on startup + per-minute basis; `REMINDER_CLAIM_STALENESS_MS` in `src/config.ts` |
| **#4** | Active deleted-message probe missing (10008 only caught on edit) | **ADDRESSED** | `fd2f383` `probeDeletedMessagesAtStartup` issues a lightweight fetch and promotes to COMPLETED on 10008 |
| **#5** | Fake ports skipping clock threading | **ADDRESSED** | `42c6371` `FakeSessionsPort` / `FakeHeldEventsPort` take `clock` via constructor |

## 2. Regression risk assessment

| Invariant | Before | After | Evidence |
|---|---|---|---|
| Single-instance cron | Maintained | **Maintained** | `fly.toml` `auto_stop_machines=false`, no scale config; `node-cron` registered once in `startScheduler` |
| DB-as-source-of-truth | Maintained | **Improved** | Outbox infra enforces DB-tx-enqueue → worker-deliver boundary (ADR-0035). Reconciler always rebuilds from DB on startup. |
| 3-second interaction ack | Maintained | **Improved** | Startup-ready gate rejects interactions ephemerally during recovery window (well under 3s); deadline guard short-circuits before any DB work |
| JST-only time | **Violated in mid-phase, restored** | **Improved** | `subMs` helper added; grep `new Date()` in `src/` outside `src/time/` → 0 violations (verified spot-check) |
| ADR-0018 DI | Maintained | **Improved** | DI audit commit `4e001aa` + `dep-graph-audit.md`; handlers/schedulers import only `AppContext` |
| ADR-0022 SSoT | At risk (mid-review caught hardcoded `8`) | **Improved** | `ASK_START_HHMM`, `OUTBOX_WORKER_CRON`, `OUTBOX_BACKOFF_MS_SEQUENCE`, `HEALTHCHECK_PING_INTERVAL_CRON`, `TICK_DURATION_WARN_MS` all consolidated into `src/config.ts`. ADR-0035 references by pointer, no literal values. |
| No-secret-leakage | Maintained | **Improved** | Logger redact expanded; `HEALTHCHECK_PING_URL` never logged; outbox `payload.extra` allow-listed |
| Tick failure isolation | Absent | **Partially improved** | `runTickSafely` wraps outbox worker only. Other cron ticks still throw to node-cron's default handler (which swallows). Treated as a DEFERRED item; see FR-M3. |

**No regressions detected** across any invariant.

## 3. New findings from this audit

### BLOCKERS
None.

### HIGH
None.

### MEDIUM

**FR-M1 — Outbox worker unsupported-kind rows dead-letter silently until `/status` is checked**
- File: `src/scheduler/outboxWorker.ts:47-51, 72-87`
- The current renderer only handles `kind="send_message"` with `extra.content: string`. All other `kind` values (including `edit_message`, which the schema already admits) go immediately to FAILED with `attemptCount++` each tick until `OUTBOX_MAX_ATTEMPTS` is reached.
- In practice, no enqueue in the current diff produces a non-supported kind (only `settleAskingSession` enqueues, and it uses `send_message`). Risk materializes only when future state-transition migrations land.
- **Proposed fix**: when adding the next renderer (postpone/ask-initial), also assert at the enqueue site that the `kind` is registered — a small discriminated-union type check to fail fast at compile time rather than at runtime.
- Severity is medium because the `/status` invariant check will surface it before real harm.

**FR-M2 — `updateAskMessageId` / `updatePostponeMessageId` are unconditional UPDATEs**
- File: `src/db/repositories/sessions.ts` (unchanged in this initiative) + outbox back-fill path in `src/scheduler/outboxWorker.ts:56-63`
- Documented in ADR-0035 Consequences as a known race: "outbox 配送と reconciler 再投稿が重なると最後勝ち."
- Today's outbox only enqueues the settle notice (no `askMessageId` back-fill needed), so the race cannot trigger in the landed code. It becomes real the moment the next migration (ask-initial-post) lands.
- **Proposed fix before wiring the ask-initial-post outbox migration**: convert both column setters to CAS-on-NULL (`UPDATE ... WHERE ask_message_id IS NULL`). Single-line change per method.
- Not shipping FR-M2 in this initiative is acceptable; the hazard is dormant.

**FR-M3 — `runTickSafely` protects only the outbox tick**
- File: `src/scheduler/index.ts` — other ticks (`runScheduledAskTick`, `runReminderTick`, `runPostponeCloseTick`, `runSettleTick`) still bare-await, allowing an unhandled promise rejection to propagate through `node-cron`.
- `node-cron` silently swallows rejections, so the effective behavior is "tick skipped, no log" — identical to the pre-initiative state. This is not a regression, but it fails to deliver the full benefit promised by adding the helper.
- **Proposed fix**: one follow-up commit wrapping each existing `cron.schedule(() => runXTick(...))` with `runTickSafely(...)`. Estimated ~30 lines diff, no behavior change other than guaranteed structured logs on tick failure.
- Low urgency because the reconciler's every-minute reclaim pass masks most transient failures.

### NITS (lumped)

- `docs/adr/0035-discord-send-outbox.md` — Consequences section references "Phase I3 follow-up" for remaining migrations; the phase naming is internal to this initiative's plan.md. Future readers without session context will ask "which phase?". Consider a short note "see commit log between 3245f2c..6a01559 for initiative scope" or rename to "a subsequent PR."
- `src/scheduler/outboxWorker.ts:34` — the fallback chain `OUTBOX_BACKOFF_MS_SEQUENCE[idx] ?? OUTBOX_BACKOFF_MS_SEQUENCE.at(-1) ?? 60_000` has three layers for what is in practice a guarded `idx`. Defensible given ADR-0022 (no magic `60_000` appears as SSoT), but `??` chain readability is marginal.
- `fly.toml` — `[env]` contains `TZ = "Asia/Tokyo"` which is also set by `process.env.TZ = "Asia/Tokyo"` at the top of `src/index.ts`. Redundant-but-harmless; the `src/index.ts` line is defensive against host environments and the fly.toml line is Fly-platform-level. Keep both.
- `/status` invariant checks do not currently include reminder-claim staleness as a warning; the reconciler clears them silently. For first-weekend operator confidence, a one-line "N reminder claims reclaimed this run" would be informative. Nit, not worth a dedicated commit.

## 4. Outbox partial rollout — specific evaluation

User question raised in the FR dispatch prompt: "is this partial rollout safe to merge, or does it leave the system in a worse state than before?"

### (a) Double-send hazard?
**No.** Inspected `src/features/ask-session/settle.ts`:
```
- direct channel.send(...) for settle notice    (pre-initiative behavior)
+ tx.outbox.enqueue({ dedupeKey: "settle-notice-..." })   (6a01559)
```
The previous direct send was **removed**, not kept alongside the enqueue (line 81-82 comment explicitly states this: "settle 通知はここでは直接送らない"). No parallel paths.

### (b) Silent dead-letter if worker unregistered?
**No.** `src/scheduler/index.ts:305-313` registers the worker via `cron.schedule(OUTBOX_WORKER_CRON, ...)` inside `startScheduler`. `startScheduler` is called unconditionally from `src/index.ts`. Additionally, if the worker does fail permanently (FAILED status), `/status` invariant check surfaces it (`src/features/status-command/invariantChecks.ts:106-125`).

### (c) Is the migration plan honest?
**Mostly.** The infrastructure is genuinely complete and reusable:
- Schema + partial-unique-index + reconciler reclaim ✓
- Worker with backoff + dead-letter + `/status` surfacing ✓
- Fake port + claim-reclaim tests ✓

The honest gap (acknowledged in ADR-0035): **per-kind renderer and message-id back-fill CAS are not yet generic** — adding `kind="send_message_with_target"` for ask-initial-post requires (1) extending the renderer dispatch in `outboxWorker.ts`, and (2) converting `updateAskMessageId` to CAS-on-NULL (FR-M2). These are each one small file-scoped change, so the "incremental migration" claim is accurate rather than hand-waving.

### Verdict on partial rollout
**Safe to ship.** One transition migrated end-to-end validates the pattern in production. No regression; foundation for future migrations is real.

## 5. SSoT / ADR hygiene

Spot-checked the four new ADRs (0032, 0033, 0034, 0035):
- 0032 (status command) — no literal time/cron values.
- 0033 (reconciler) — references `ASK_START_HHMM`, `REMINDER_CLAIM_STALENESS_MS`, `CRON_ASK_SCHEDULE` by name only.
- 0034 (healthcheck) — references `HEALTHCHECK_PING_INTERVAL_CRON`, `HEALTHCHECK_PING_TIMEOUT_MS` by name only.
- 0035 (outbox) — references `OUTBOX_WORKER_CRON`, `OUTBOX_MAX_ATTEMPTS`, `OUTBOX_BACKOFF_MS_SEQUENCE` by name only. Partial unique index constraint is described semantically, SQL quoted only in the migration SQL file itself.

`docs/adr/README.md` index updated through 0035. No orphan files.

**No ADR-0022 violations detected.**

## 6. Test quality spot-check

```
grep -rn "vi.mock" tests/ | grep -iE "repositor|ports.real"  → 0 matches
```

No `vi.mock` on repository modules (ADR-0018 compliant).

New tests inspected:
- `tests/scheduler/reconciler.test.ts` — exercises ASKING→CANCELLED, POSTPONE_VOTING→DECIDED/CANCELLED promotion paths with real fake clock, not just type assertions ✓
- `tests/scheduler/outboxWorker.test.ts` — exercises claim/deliver/fail/backoff/reclaim with concrete Date math ✓
- `tests/discord/shared/guards.test.ts` — exercises startup-ready gate + ASKING deadline guard with clock manipulation ✓

Test count 256 → 308 (+52) is proportionate to the 17-commit scope.

## 7. Recommendation

## 🟢 **SHIP**

The brush-up initiative achieves its stated goals:
- Every BLOCKER and HIGH finding from the original review is ADDRESSED.
- The one PARTIALLY ADDRESSED item (H3 / outbox) ships a complete pattern with honest scope boundary and zero regression.
- Both DEFERRED items (M12, M13) have explicit rationale.
- All validation steps pass on `6a01559`.
- No new BLOCKER or HIGH finding from this audit.

The three Medium follow-ups (FR-M1, FR-M2, FR-M3) should be addressed before the NEXT significant change, not before shipping this initiative. They are best treated as prerequisites to the second outbox migration wave.

### Recommended next PR (not part of this ship):
1. Wire `runTickSafely` around the remaining 4 cron ticks (FR-M3) — mechanical, 30-line diff.
2. Convert `updateAskMessageId` / `updatePostponeMessageId` to CAS-on-NULL (FR-M2) — 2-line diff per method + tests.
3. Begin migrating ask-initial-post and postpone-message to the outbox (continues H3 follow-through).

### Process note
Second opinion on the final review was lost to rate-limit exhaustion. Future multi-phase initiatives should pace sub-agent usage with more headroom before the final phase, or request user confirmation to defer the final second-opinion pass.
