# Final Review — Second Opinion

## BLOCKING

1. **The new outbox enqueue path is broken against the real schema.**  
   `drizzle/0006_living_hedge_knight.sql:21` creates a **partial** unique index on `dedupe_key`, but both enqueue sites use `ON CONFLICT (dedupe_key) DO NOTHING` without the predicate (`src/db/repositories/outbox.ts:123-132`, `src/db/repositories/sessions.ts:223-235`). The first real `cancelAsking(...outbox)` path (`src/features/ask-session/settle.ts:47-69`) will hit that SQL, so this is not theoretical. On PostgreSQL, that conflict target does not match a partial unique index; the insert will error and abort the transition transaction instead of deduping.  
   **Fix:** make the conflict target match the partial index predicate, or switch to a non-partial uniqueness design and verify it with an integration test on real Postgres before shipping.

## HIGH

1. **The partial outbox rollout leaves one cancel flow with two delivery semantics, and the ordering is now wrong.**  
   `src/features/ask-session/settle.ts:47-69` outboxes the settle notice, but `src/features/ask-session/settle.ts:80-108` still sends the postpone message directly. So the user-visible sequence can now be “postpone vote appears immediately, settle notice arrives up to 10s later” instead of the old in-order flow. Worse, startup only releases expired claims (`src/scheduler/reconciler.ts:601-608`), and the worker starts only after recovery/scheduler registration (`src/index.ts:179-188`, `src/scheduler/index.ts:305-314`), so a crash or misregistered worker can leave that one notice PENDING while the rest of the state machine advances.  
   **Fix:** either keep this path synchronous until the whole cancel flow migrates, or migrate settle notice + postpone post together and drain pending outbox rows before declaring ready.

2. **Reconnect still does not replay missed work.**  
   After startup, disconnect/reconnect only toggles the ready gate (`src/index.ts:40-54`). Recovery itself runs only once during boot (`src/index.ts:167-179`), while cron tasks keep living for the lifetime of the process (`src/index.ts:183-188`, `src/scheduler/index.ts:288-319`). If Discord/API availability is bad during Friday ask or a deadline/reminder tick, the send/settle can fail and nothing reruns automatically on reconnect. That is exactly the “first real weekend after deploy” failure mode.  
   **Fix:** on post-startup `shardReady`, rerun `runReconciler(scope="startup")` + `runStartupRecovery()` (or pause cron while disconnected and replay on reconnect).

3. **`runTickSafely` is still not the scheduler contract.**  
   `src/scheduler/tickRunner.ts:1-3` explicitly says every cron callback should be wrapped, but `src/scheduler/index.ts:288-314` wires it only for `outbox_worker`. The other critical ticks still rely on ad hoc inner `try/catch`. That means the stated goal of uniform tick-level failure isolation/telemetry is not actually achieved for ask/deadline/postpone/reminder/healthcheck.  
   **Fix:** wrap every registered tick with `runTickSafely(...)` and keep per-tick bodies responsible only for finer-grained per-session isolation.

## NOTABLE

1. **ADR-0035 is too optimistic about “incremental migration.”**  
   The worker currently only knows text `send_message` payloads (`src/scheduler/outboxWorker.ts:42-50`, `src/scheduler/outboxWorker.ts:93-125`); `edit_message` is intentionally dead-lettered. Message-ID backfill is also still unconditional last-write-wins (`src/scheduler/outboxWorker.ts:101-105`, `src/db/repositories/sessions.ts:129-148`), and the ADR already admits that race (`docs/adr/0035-discord-send-outbox.md:96-99`). So migrating ask/postpone/edit paths is meaningfully harder than “the infrastructure is in place.”  
   **Fix:** either tone down the ADR claim, or finish renderer coverage + NULL-only/CAS backfill before calling the rollout path-ready.

2. **The deploy-freeze rule is still doc-only.**  
   It is documented in `fly.toml:3` and `README.md:267-271`, but there is no enforcement in CI or any checked-in deploy workflow (`.github/workflows/ci.yml:1-126`). If the freeze window matters, comments and PR checklists are not enough.  
   **Fix:** put the time guard in the actual deploy path, or explicitly reclassify it as an operator-only convention.

3. **ADR SSoT discipline slipped again.**  
   ADR-0034 says config is the only SSoT, but still writes the timeout literal into the ADR (`docs/adr/0034-healthcheck-ping.md:35-44`). ADR-0035 also writes the worker cadence into prose (`docs/adr/0035-discord-send-outbox.md:95-98`). Small, but this is exactly the drift ADR-0022 was supposed to stop.  
   **Fix:** replace copied literals with constant names only.

## VERDICT

**DO NOT SHIP**
