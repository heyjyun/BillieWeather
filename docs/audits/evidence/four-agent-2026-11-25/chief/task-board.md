# Task board — four-agent audit 2026-11-25

Integration candidate: branch `audit/four-agent-2026-11-25` (worktree `../billieweather-audit`), based on local `main` 1656256. Chief only commits here.

## Phase 0 baseline (Chief, verified 2026-11-25)
- Shared .git across: `billieweather` (phase-1a-modular-shell @ e4380af = origin/main, 114 dirty files, archived as commit 8f6d0a3 on archive/phase1a-checkpoint, NOT in main), `billieweather-roadmap` (autonomous-development @ 34a2aeb, 18 untracked Phase 6.3 evidence files from another session), `billieweather-dualmac` (infra/dual-mac @ 3afc9cb), scratch worktree wt79 (other session).
- Local main 1656256 = 70 commits ahead of origin/main, not pushed.
- Live foreign processes (DO NOT TOUCH): dev stack on :3000 (Rails, .env.local -> Neon), :8100 identity, :1420 vite; roadmap session Rails :38530 / identity :38531 / temp PG /private/tmp/billie-roadmap.*; session 706fd939 `run-e2-retry.sh` waiting for idle desktop to drive native QA app com.billieweather.client.qa.p63.
- Installed: /Applications/BillieWeather.app + several QA data dirs. Do not replace/uninstall.
- Phase 6.3 artifacts: ClaudeGenerated/phase6.3-rc1, phase6.3-rc2, checkpoint-phase6.3; docs/audits/phase6.3-*.md.

## Isolation allocation
| Agent | PG temp cluster port | Rails port | identity port | scratch dir |
|---|---|---|---|---|
| A | 55431 | 3211 | 8211 | own session scratchpad |
| B | 55432 | 3212 | 8212 | own session scratchpad |
| C | 55433 | 3213 | 8213 | own session scratchpad |
Always `unset DATABASE_URL` and never source .env.local. Native GUI: NOT allowed (desktop slot held by another session; needs user authorization).

## Tasks
| ID | Owner | Pri | Depends | Task | Acceptance |
|---|---|---|---|---|---|
| T-A1 | A | P0 | – | Architecture + data-flow map (Rails, identity-api, SQLite, Neon, client API, sync/offline) | diagram + file:line evidence |
| T-A2 | A | P0 | – | Schema/migration/rollback/relationship + import idempotency, dedupe, recovery, swallowed errors, DB discovery | risk list w/ evidence; repro tests |
| T-A3 | A | P1 | T-A1 | Multi-account / multi-database isolation | test or code proof |
| T-B1 | B | P1 | – | Platform capability matrix (web/macOS/Win/iOS/Android) from code+evidence | matrix with evidence level |
| T-B2 | B | P1 | – | Journey audit: onboarding/nickname/auth/nav/Transactions/AI/Settings/Add&Sync (CSV/PDF/receipt/manual) | journey defect list w/ repro |
| T-B3 | B | P1 | – | Modules vs preferences vs navigation vs tests consistency (Categories false-failure) | root cause + evidence |
| T-C1 | C | P0 | – | Test/CI inventory; run Rails/vitest/cargo/identity tests on isolated DBs | command + pass/fail counts |
| T-C2 | C | P0 | – | Security: secrets, deps, authn boundaries, CORS/network | findings w/ evidence |
| T-C3 | C | P1 | – | Phase 6.3 GUI/rollback failure analysis (read-only of other session's evidence), RC provenance, timing races | closure status |
| X-1 | A→B | – | P1 | A reviews B's data assumptions | |
| X-2 | B→C | – | P1 | B reviews C's journey coverage | |
| X-3 | C→A | – | P1 | C challenges A's migration/integrity claims | |
