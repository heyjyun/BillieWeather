# Agent A — Architecture & Data Integrity (Phase 1)

Filed by Chief from Agent A's hand-back (subagent could not write this file). Repro tests: `repro/agent-a-local-data.test.ts`, `repro/agent_a_server_import_test.rb` (passing ⇒ defect reproduced).
Chief spot-verified 2026-11-25: A-01 (`clients/universal/src-tauri/vendor/tauri-plugin-sql/src/commands.rs:35` removes migrations from map before `pool.migrate`), A-06 (`app/services/finance/statement_importer.rb:134-135` post-commit steps), A-08 (`app/services/finance/data_deletion.rb:33` purge before delete_all).

## Incident (shared scratch pointer)
A also used shared `scratchpad/pgdir`; at ~17:34 A ran `pg_ctl stop` + `rm -rf` on whatever pgdir named (overwritten by another agent at 17:31). Combined with C's report, at least one other agent's temp cluster was stopped/deleted. No user/real data involved (all in session scratch). A's own cluster on :55431 was stopped by PID and removed. Side effects: `src-tauri/gen/schemas` (gitignored) created then removed; `coverage/` and `log/test.log` touched; `db/schema.rb` mtime changed with empty diff (likely C's remigrate).

## (a) Current architecture
```mermaid
flowchart LR
  subgraph Device["Tauri client (macOS built; iOS/Android/Windows code only)"]
    UI[React UI clients/universal/src] --> SQLP[vendored tauri-plugin-sql 2.6 / sqlx 0.9]
    SQLP --> S1[(SQLite slots 1..8 billieweather[-N].db\nsettings.owner_account_id)]
    UI --> REG[localStorage registry per owner]
    UI --> OCR[Apple Vision OCR worker, out-of-process]
  end
  subgraph Server["Render (not touched)"]
    RAILS[Rails web + /api/client/v1] --> PG[(Neon Postgres — system of record)]
    ID[identity-api FastAPI] --> PG
  end
  UI -- bearer token --> RAILS
  UI -- sign-in --> ID
  RAILS -- statement rows, merchant rules, custom categories --> UI
  UI -- explicit transfer: statement, DB metadata, receipts, AI-categorize payloads, module prefs --> RAILS
```
Never synced: manual/receipt/recurring entries; accounts, tags, budgets, links (`app/controllers/client_api/.../finance_controller.rb:179`). identity-api writes `users`, `teams`, `memberships` directly (`services/identity-api/identity_api/accounts.py:66-89`).

## (b) Schema
Server: composite owner FKs on every finance child (`db/schema.rb:983-1031`); statement idempotency `(user_id, sha256)`. Local: 10 forward-only migrations, FKs on; rollback = restore `.bak`/backup. Single-process lock on data folder.

## (c) Findings (no P0)
| ID | Sev | Class | Location | Summary |
|---|---|---|---|---|
| A-01 | P1 | CONFIRMED-by-code | vendor/tauri-plugin-sql/src/commands.rs:33-40 | migrations removed from map before run; on failure (newer/locked/full) a retry/switch/`reportMetadata` opens the slot unmigrated and skips the downgrade check. App has no own schema-version check. Triggered by "Try again" (`src/hooks/useFinance.tsx:319`). |
| A-04 | P1 | REPRODUCED | src/services/store.ts:1186-1294 | `applyWebData` dedupes only by file hash → same rows from a different file stored twice; spending doubled (49.00 vs 24.50). |
| A-05 | P2 | REPRODUCED | src/services/ledger.ts:531-560 (callers store.ts:504,1004,1012,1193,1228) | accounts/audit/custom categories outside atomic batch → orphan account on failed commit; `hasContent()=true` on empty book. |
| A-06 | P2 | REPRODUCED | app/services/finance/statement_importer.rb:129-141 | post-commit recategorize/BalanceSync failure reports import failed though saved; retry says "already imported". |
| A-07 | P2 | REPRODUCED | app/services/finance/duplicate_detector.rb:55-58 | identical row in second identity-less CSV silently skipped — documented fixture; product decision. |
| A-08 | P2 | CONFIRMED | app/services/finance/data_deletion.rb:33-34 | receipt blobs purged inside tx before row deletes; rollback leaves files gone. |
| A-02 | P2 | CONFIRMED | src-tauri/src/snapshot.rs | retention keeps newest 2 by time only (qa.p63: two pre-v10, none older); sizes ignore `-wal`. |
| A-03 | P2 | CONFIRMED | src/services/backup.ts:20 | `LOCAL_SCHEMA_VERSION`, `MAX_DATABASES` duplicated Rust/TS, no parity test. |
| A-09 | P2 | CONFIRMED | app/controllers/finance/base_controller.rb:86-96, balance_sync.rb:11 | every finance GET locks + writes. |
| A-10 | P2 | CONFIRMED | base_controller.rb:75 | "income to check" count capped at 2000. |
| A-11 | P2 | CONFIRMED | identity_api/accounts.py | second writer to `users`; compat tests mitigate. |
| A-12 | P2 | CONFIRMED | – | sync asymmetric (design). |
| A-13 | P2 | CONFIRMED | useFinance.tsx removeDatabase | removing a DB keeps `.bak`, no pre-delete copy. |
| A-14 | P2 | HYPOTHESIS | vendor plugin `load` | accepts any `sqlite:` path (= C-09). |
| A-15 | P2 | CONFIRMED | store.ts | server-side delete removes local row even if edited on device. |

Verified fixed: local DB discovery (failed-open book stays listed; only other-account books removed; 8 tests in `test/databaseOpenFailure.test.tsx`); Phase 0 items (SHA-256 format check, account deletion with receipts, AI categorization audit). Owner isolation correct device and server.

## (d) Target architecture (no rewrite)
1. Native `db_open` gate: snapshot → migrate → verify `user_version`/expected max; retain migrations on failure (A-01, A-03, A-14).
2. Single row-ingress pipeline: plan → dedupe (row-level) → one batch (A-04, A-05, A-07, A-15).
3. Server side effects only on writes; post-commit steps non-fatal and logged (A-06, A-08, A-09).
4. Entity-level uuid sync — post-release.

## (e) Commands/results
`cargo test --offline --locked` 44 pass; focused vitest 25 files 340 pass; full vitest 1167 pass/13 skip; focused Rails (models, services, lib, client_api/finance/local_database integration; temp PG14 :55431) 666 tests/5880 assertions/0 F/1 skip; A repros 2 vitest + 2 Rails pass; PG probe: merchant delete nullifies `merchant_id`.

## Proposed fixes (ownership)
F1 A-01/03/14: vendor plugin commands.rs, wrapper.rs, src/services/platform.ts, backup.ts, new test/schemaGate.test.ts, Rust test in src-tauri/src/lib.rs.
F2 A-04/05/15: store.ts, ledger.ts, test/webSync.test.ts, test/atomicity.test.ts.
F3 A-02/13: snapshot.rs, useFinance.tsx (after F1).
F4 A-06: statement_importer.rb (+draft_import.rb check), its test.
F5 A-08: data_deletion.rb, its test.
F6 A-09/10: base_controller.rb, balance_sync.rb.
F7 A-07: product decision first.
Defer A-11, A-12.
