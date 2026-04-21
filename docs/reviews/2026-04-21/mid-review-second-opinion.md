# Phase I1+I2 second opinion

## Verdict
**ship with fixes** — good progress, but there are still a few correctness/ops gaps I would close before calling Phase I1+I2 done.

## Issues the primary reviewer likely missed

1. **Blocking — interactions are live before reconcile/startupRecovery finishes, and overdue ASKING buttons still accept writes.**  
   - `src/index.ts:19-21`, `src/index.ts:94-145`, `src/features/ask-session/button.ts:68-75`, `src/features/ask-session/button.ts:91-103`, `src/features/ask-session/button.ts:143-148`, `src/features/ask-session/decide.ts:50-52`
   - `registerInteractionHandlers()` is wired before login, and nothing gates handlers while `runReconciler()` / `runStartupRecovery()` are still running. Once `client.login()` resolves, an interaction can hit an overdue `ASKING` session before startup recovery settles it. Worse, the ask-button path only checks `status === "ASKING"` and never checks `deadlineAt > now`, so a late click can still upsert a response and even drive `DECIDED` if it becomes the 4th answer.
   - **Fix:** add a startup-ready gate at interaction ingress (ephemeral “booting, retry”) and add an ASKING deadline-open guard analogous to `guardSessionPostponeDeadlineOpen`.

2. **High — “deleted Discord message” recovery is still not actually part of the reconciler path.**  
   - `src/scheduler/reconciler.ts:354-355`, `src/scheduler/index.ts:130-153`, `src/scheduler/index.ts:230-257`, `src/features/ask-session/messageEditor.ts:29-58`
   - ADR/final-report scope said startup recovery should cover deleted ask messages, but `runReconciler(scope="startup")` explicitly does not. The only recovery path is opportunistic: `updateAskMessage()` recreates on 10008 when some later edit path happens. If the ask message was deleted while the bot was down and nobody clicks anything, startup leaves it missing.
   - **Fix:** during startup reconcile, actively probe stored `askMessageId` / `postponeMessageId` and recreate on 10008, instead of waiting for a later redraw path.

3. **Medium — `/status` does not surface stranded `CANCELLED`, so it misses the exact C1 state it is supposed to help operate.**  
   - `src/features/status-command/handler.ts:37`, `src/db/repositories/sessions.ts:15-20`, `src/db/repositories/sessions.ts:429-436`
   - `/status` reads only `findNonTerminalSessions()`, and `CANCELLED` is excluded from that set. If startup reconcile fails, or an operator invokes `/status` while investigating C1, the command omits the stranded row entirely.
   - **Fix:** include `findStrandedCancelledSessions()` in the status snapshot/warnings, or add a dedicated invariant query that merges non-terminal rows with stranded `CANCELLED`.

4. **Medium — ADR-0022 drift has already crept back into the new reconciler path.**  
   - `src/scheduler/reconciler.ts:60-68`, `src/scheduler/reconciler.ts:172-174`, `docs/adr/0001-single-instance-db-as-source-of-truth.md:17`
   - `isFridayAskWindow()` hardcodes `08:00`, and ADR-0001 still says “金曜 18:00”. That means the new catch-up logic can drift from `src/config.ts` / requirements again, which is exactly the class of bug ADR-0022 was meant to prevent.
   - **Fix:** derive the ask-window start from the runtime SSoT (`src/config.ts` / a time helper) and clean the stale 18:00 prose from the updated ADR.

5. **Medium — healthcheck observability is still boot-only in code, despite docs saying minute-tick ping, and the boot ping is silent on success.**  
   - `src/index.ts:159-165`, `src/scheduler/index.ts:130-153`, `README.md:289-291`
   - The implementation only fires a best-effort boot ping. There is no per-minute scheduler ping, so healthchecks cannot detect a process that boots successfully and dies later. Also, a valid-but-wrong `HEALTHCHECK_PING_URL` stays invisible because success is not logged at all.
   - **Fix:** add the documented minute-tick ping with a short timeout, and emit a redacted success/failure signal (counter/event only, not the URL) so miswiring is detectable.

## Concerns I want validated

- `fly.toml:14-20`, `README.md:267-277` — there is still **no deploy-time safeguard** for the Friday 17:30–Saturday 01:00 freeze; the file only documents the rule. If deploy safety is a real requirement, it needs to live in the deploy workflow/operator script, not only in comments.
- `.github/dependabot.yml:3-10`, `.github/workflows/ci.yml:17-23` — weekly Actions updates with no ignore rules are probably fine for volume, but I would validate whether you want to permit **major** action jumps automatically or pin to the current major train.
- `src/features/status-command/invariantChecks.ts:55-67` — the stale-claim warning treats any `DECIDED + reminderSentAt != null + HeldEvent missing` as stale immediately; that may be noisy for a legitimately in-flight reminder path.

## Disagreements anticipated

- If the primary reviewer blocks on `/status` leaking reconciler internals to out-of-scope guild members, I would push back: `assertGuildAndChannel()` + `assertMember()` correctly fence the reply to the 4-user allowlist, and the command does not expose stack traces or raw error text (`src/features/status-command/handler.ts:24-33`).
- If they call out remaining forbidden-pattern debt in `src/`, I would push back on that too: `transitionStatus` is gone, I found no `console.log`/`console.error`, and no direct `process.env` reads outside the intended env bootstrap/comments sweep.
