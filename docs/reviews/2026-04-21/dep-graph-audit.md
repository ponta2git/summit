# AppContext DI Compliance Audit (ADR-0018)

Date: 2026-04-21
Scope: `src/**` runtime code audit for direct DB/time/env dependency violations.

## Reproducible search commands
- `rg -n "import\\s+.*from\\s+[\"'][^\"']*db/client(?:\\.js)?[\"']" src`
- `rg -n "import\\s+.*from\\s+[\"'][^\"']*db/repositories[^\"']*[\"']" src`
- `rg -n "\\bnew Date\\s*\\(" src`
- `rg -n "process\\.env" src`

## Findings summary
- Violations found: **0**
- Violations fixed: **0**
- Violations deferred: **0**

## Details
### 1) Direct `db/client` imports outside allowlist
- Matches: `src/appContext.ts`, `src/index.ts`
- Result: both are in the allowlist; no violation.

### 2) Direct `db/repositories` imports outside allowlist
- Matches: none in `src/**`
- Result: no violation.

### 3) Direct `new Date()` outside `src/time/`, `src/scripts/`, `tests/`
- Matches found in `src/time/index.ts` only.
- Result: no violation.

### 4) Direct `process.env` reads outside `src/env.ts` and scripts/config
- Code matches found in `src/env.ts` only.
- Additional matches in comments/docstrings (non-executable):
  - `src/features/reminder/send.ts`
  - `src/time/index.ts`
  - `src/scheduler/reconciler.ts`
- Result: no violation.

## Conclusion
Codebase is clean for the audited ADR-0018 DI constraints in this scope.
