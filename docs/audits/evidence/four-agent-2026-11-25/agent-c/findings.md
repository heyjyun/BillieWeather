# Agent C — QA, Security & Release Engineering (Phase 1)

Filed by Chief from Agent C's hand-back (the subagent could not write this file itself). Raw logs: `logs/`.
Chief spot-verified on 2026-11-25: C-04 (cors.rb:22-33), C-03 module default (packages/shared-types/schema/module-catalog.json:37), Add & Sync nesting (clients/universal/src/App.tsx:203-204), C-02 mapping (clients/universal/src/services/databases.ts:154).

## Incident
C's cleanup `rm -rf`'d Agent B's scratch dir `scratchpad/pgB.oFYR` via an overwritten shared pointer file `scratchpad/pgdir`. No live cluster was found there (no data dir, nothing on 55432). B notified. Lesson: never use shared pointer files in a shared scratchpad. Logs in `logs/` could in principle include same-named output from another agent; counts were observed live.

## (a) Test matrix (isolated PG14 :55433, private redis :56433, DATABASE_URL/NEON_*/RENDER_* unset)
| Suite | Result |
|---|---|
| Rails `bin/rails test` | 858 tests, 0 F, 0 E, 2 skips (Bullet Train template tests) |
| Rails system tests (26 files) | NOT RUN — no built assets / Chrome |
| Client `tsc --noEmit` + `npx vitest run` | tsc clean; 1178 tests: 1165 pass, 13 skipped (real-engine OCR) |
| identity-api pytest | 129 pass, 1 skip |
| identity-api pytest `IDENTITY_RAILS_COMPAT=1` | 130 pass |
| `cargo test --offline --locked` | 41 + 3 pass |
| Rails migration rollback 32 + re-migrate | reversible; schema identical modulo PG formatting (empty DB) |
| bundle-audit / npm audit / cargo audit | 0 vulns (cargo: 5 unmaintained, 1 unsound, transitive) |
| brakeman | 3 warnings |
| pip-audit | not installed |

CI gaps: no cargo test, no identity pytest, no dependency audits, no Rails system tests; Rails CI on `postgres:11-alpine`.

## (b) Findings
- **C-01 P1 CONFIRMED (binary provenance):** native Phase 6.3 runs a1, b1, c1, c2, e1 ran on **rc1** (07f5ec4, build 119, exe 2b6ad246…), not rc2 (34a2aeb, build 121, exe 186f5483…, built after those runs). Only e2 (other session, in progress) targets rc2. rc1→rc2 diff: styles.css + Rails system tests only; rc2→main: ops/ + docs/ only ⇒ rc2 ≡ main for the shipped app.
- **C-02 P1 CONFIRMED-by-code / UNTESTED E2E:** "0.1.0 refuses schema-10 DB" relies on SQLx missing-migration error mapped to "newer" (`clients/universal/src/services/databases.ts:154`; same in 0.1.0). Never passed natively; nor "restore automatic copy" nor "upgrade forward again". Chief note: the same regex also maps "has been modified" (checksum mismatch) to "newer", which is a misleading message.
- **C-03 P2 CONFIRMED (harness defects):** Categories default off (module-catalog.json:37), a1 enabled only Budgets → false failure (label is "Categories & Tags"); e1 fixed 4 s sleep read only window title (screenshot byte-identical to rc2 pass); e2 `manual_home()` clicks "Add & Sync" which only exists inside Transactions (App.tsx:204) → cascade of undo/edit/rollback failures; harness reports disabled and missing both as "NOT FOUND".
- **C-04 P2 REPRODUCED:** `config/initializers/cors.rb:27-31` `origins "*"` on `/api/*` (includes `/api/client/v1/*` except module_preferences) with `headers: :any` → ACAO * + Authorization from any origin. Not exploitable without a stolen bearer token.
- C-05 P2: web CSP lacks `script-src`.
- C-06 P2: `public_send` in `app/controllers/finance/receipts_controller.rb:89`, guarded only by route constraint.
- C-07 P2: committed dev/test `secret_key_base` in `config/secrets.yml:14,17` (not production).
- C-08 P2: rate limits untested (null cache store in test); production falls back to per-process memory without `REDIS_URL`.
- C-09 P2 HYPOTHESIS: vendored `tauri-plugin-sql` `path_mapper` (`src-tauri/vendor/tauri-plugin-sql/src/wrapper.rs:368`) allows absolute / `../` DB paths.
- C-10 P2: Android/Linux token file chmod 600 after write (`src-tauri/src/session.rs`).
- C-11 P2: `down` of `db/migrate/20261109000200_move_payment_qr_codes_to_active_storage.rb` drops stored QR files.
- No secrets in tracked files or the 128-commit history. Sound: server-side revocable client-API sessions; identity-api token/signature checks; OCR worker out-of-process with timeouts and size caps.

## (c) Phase 6.3 closure
Categories: closed (test-design). Migration-screen race: closed (behaviour passes on rc2). Native rollback: **OPEN**. Undo bar on rc2: not natively proven.

## (d) Preliminary verdicts
Web: CONDITIONAL GO (owner SECRET_KEY_BASE removal + master-key check; Redis required). macOS arm64: CONDITIONAL GO personal/ad-hoc, NO-GO distribution (unsigned, unnotarized, rollback unproven). macOS Intel / Windows / iOS / Android: NO-GO (never built).

## Proposed Phase 3 fixes (file ownership)
1. cors.rb + new test/integration CORS test. 2. receipts_controller.rb allowlist. 3. config/secrets.yml literals. 4. rate-limit test (test/controllers/client_api/v1/) + production.rb REDIS_URL guard. 5. wrapper.rs DB-name restriction. 6. session.rs 0600 at create. 7. QR migration down guard. 8. downgrade-fence cargo test in src-tauri/src/lib.rs. 9. CI: Postgres major version, cargo test, identity pytest + audits workflow. 10. Harness fixes in other session's n/accept.py, n/e2.py — owner only, after that session finishes.
