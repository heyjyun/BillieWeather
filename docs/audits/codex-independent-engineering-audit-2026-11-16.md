# Independent engineering audit — 2026-11-16

## Scope and safety baseline

- Repository: `billieweather`, branch `main`, initial HEAD `cf7a1b0` (`manual1`). Initial `git status --short` was empty.
- No commits, pushes, deployments, production connections, real financial records, environment-file changes, or access to `../local-db-backups-20261113/` are authorized or performed.
- PostgreSQL verification explicitly sets **both** `DATABASE_URL` and `DATABASE_URL_UNPOOLED` to the disposable local database `postgresql://localhost/billieweather_codex_audit_test`. This is necessary because the repository's development environment can otherwise select a remote database and its Rake tasks can replace the primary URL with the unpooled URL.
- SQLite tests use in-memory sql.js and synthetic fixtures. Native snapshot tests must use temporary directories, never application data.
- Ruby 4.0.3 is installed through mise; the shell's default Ruby is 2.6.10. Commands explicitly prepend the installed Ruby's `bin` directory. `bundle check` succeeds with that runtime.

## Initial architecture findings

- Rails 8.1/Bullet Train + PostgreSQL serves the web application and bearer-token client API; React/TypeScript + Tauri 2 + SQLite serves local-first clients. A Python forecasting service is optional. Shared TypeScript packages centralize parsing, money, domain contracts, reporting, and commands; Ruby mirrors selected domain rules using shared JSON fixtures.
- The November 15 architecture review predates substantial ledger implementation. The subsequent domain specification and implementation report claim fixes for all five original critical findings. Those claims require independent behavioral verification, particularly across legacy import, cloud download/upload, restore, and edit paths.
- Existing tests cover many happy paths and domain contracts. The principal complexity is multiple independently evolving representations and write paths: Rails decimal money versus SQLite integer cents, two import pipelines, cloud copies, local transfers, triggers, manual entries, and user overrides.
- Scope will favor incremental integrity/security fixes and measured improvements over replacing the application framework or adding dependencies.

## Confirmed defects and implemented changes

### P0: account isolation and ownership migration

1. **Token/cache mismatch could mix accounts.** A system-keychain token and localStorage profile are separate writes. Previously, the cached profile could immediately mount its database while the token belonged to another account, allowing the wrong cloud download. `AccountProvider` now exposes the token to cloud consumers only after the server binds it to the displayed identity. Cached local data remains usable offline. Online reconnection revalidates the identity; obsolete in-flight verification responses are ignored. `Gate` refuses to mount a provider with asynchronously derived keys from a previous identity. A deferred-response regression reproduces this boundary.
2. **First-login adoption was not evidence of ownership.** An unowned database with content now always uses the existing explicit ownership dialog. Upgrading an email-hash binding to an immutable server id also requires confirmation when content exists. Empty slots can still be claimed automatically. The obsolete `adoptsLegacyList` helper was removed. The domain specification now describes this deliberate behavior change; unrelated UI fixtures explicitly record their synthetic owner.
3. **Automatic snapshot restoration bypassed ownership checks.** Previously, any listed snapshot could be copied and rebound to the current account. The copied file's embedded owner is now checked before registration, metadata reporting, or rebinding. A foreign copy made by this operation is cleared; its source snapshot remains untouched. Authorized copies receive a fresh metadata identity instead of reusing `report_id`. Tests cover both rejection and successful identity reset. The restore button now catches failures and disables concurrent actions.
4. **Slots containing only categories/rules could be reclaimed.** `hasContent` now includes all persistent financial content, not just statements, accounts, and a database name.

### P0: financial meaning and source evidence across transfers

5. **Download discarded server fields.** Rails already emitted `kind` and `original_description`, but `fetchWebData` ignored them. Refunds could become income through legacy sign inference, and edited labels could replace bank evidence in new device copies. Both fields now travel through the network adapter, cloud-to-local copy, local export/merge, and explicitly requested upload. Older payloads retain their fallback behavior.
6. **Upload re-inferred explicit device decisions.** The API now validates optional kinds and original descriptions, and `ImportPlan` preserves them. Dedupe compares bank descriptions, so changing only a display label cannot evade overlap detection. Invalid shapes/classifications are rejected before insert. No new financial fields are uploaded automatically.
7. **A partial download could be treated as deletion.** Transaction pagination now requires strictly increasing ids and a valid advancing cursor. Reaching the safety limit with another page pending fails before `applyWebData` can remove absent copies. A malformed/looping server response is covered by regression testing. Normal sync also reuses its first summary instead of fetching the same summary twice.

### P0: refunds and account balances

8. **Refund caps applied mainly at creation.** Restoring an old refund after its allowance was reused, shrinking its original expense, or changing a refund amount without resubmitting its target could violate the cap or leave the link amount stale. New additive SQLite migration `0008_refund_integrity.sql` guards edits, restoration, and confirmed refund links. Refund edits/relinking now use one transaction update plus triggers, so a failing link rolls back the financial edit. A refund has only one confirmed original expense. Relinking and batch undo are covered.
9. **Rails needed the same lifecycle checks.** Ledger writes and restoration validate live confirmed refund totals under the existing per-user lock. Category callbacks normalize kind before relation validation. Reclassifying a refund releases its old relation. Refund accounting sums the actual live transaction amounts rather than trusting stale link amounts.
10. **Statement reassignment left ledger accounts stale.** Changing `statement.bank_account_id` now updates the corresponding imported transaction accounts in the same database transaction. Explicitly locked per-entry account overrides are preserved. Amounts, dates, descriptions, and original bank text stay unchanged. The old integration assertions compared every attribute, including the account and timestamp; they were narrowed only for these intended metadata changes and strengthened with explicit account assertions.

### P0: backup integrity and migration protection

11. **Restore could clear a target containing non-transaction data.** Restore now checks every financial table and meaningful settings before writing. Preflight failures leave existing data untouched.
12. **Restore trusted internal callers and silently dropped schema fields.** Both `readBackup` and `restoreInto` verify format, supported version, table/column/row shapes, manifest counts, safe integer totals and per-cell cents, and SHA-256. Device settings are excluded by their column names even when backup columns are reordered. Unsupported columns/tables are rejected rather than discarded. Encrypted headers bound PBKDF2 work and validate the encryption parameters. A foreign-key check catches orphaned financial rows even with sql.js foreign-key enforcement disabled.
13. **Backup's second read could disagree with the exported rows.** The manifest is derived from captured rows. This removes that mismatch, but does not claim a transactionally consistent multi-table read during concurrent background writes (see remaining risks).
14. **Pre-migration snapshot failure was ignored.** Native startup now fails with a generic error if a required protective copy fails, preventing the SQL plugin from migrating the only copy. No paths or financial contents are included in that error.

### P1/P2: undo, logging, and maintainability

15. **Batch tag undo did not restore tags, and repeated undo could replay undo events.** Rails restores prior tags and audited lock/provenance fields; undo events are excluded from the original batch. Refund validation also applies to undo. Tests exercise tags and repeated undo.
16. **New manual financial payloads were not all log-filtered.** Entry, transaction, merchant/dimension, budget, recurring template, note, and automation payloads are now redacted. A parameter-filter regression preserves operational metadata while hiding synthetic financial context.
17. **Unrestricted parameter permitting was unnecessary.** Local database metadata validates unexpected keys first, then permits only the existing explicit allowlist. This retains rejection semantics and removes `permit!`.
18. **HEAD language links took the non-GET branch.** The helper now treats GET and HEAD consistently. Brakeman still emits one weak-confidence warning on this expression; both verbs are explicitly handled.
19. **A date-dependent integration test used a different timezone from its user.** Its `today` helper now follows the controller's actual user timezone. The initial full Rails run exposed this failure; it was a test expectation problem rather than a recurrence-engine defect.

## Architecture decisions

- Keep the existing Rails/PostgreSQL and Tauri/SQLite split. Exact decimal money on Rails and integer cents locally are appropriate; the dangerous gaps were transfer contracts and alternate write paths, not the framework choices.
- Prefer additive guards and existing locks/triggers over table rebuilds or speculative new abstractions. SQLite pooled connections make a sequence of separate SQL calls unsuitable for atomic financial edits; refund relinking therefore joins the established trigger approach.
- Retain existing immutable source evidence. Historical device copies whose bank text was already lost cannot safely be reconstructed from an edited label; this audit does not rewrite them or reclassify real historical income automatically.
- Ownership migration now favors explicit confirmation over the former first-sign-in heuristic. A device-wide registry and a reused email cannot establish which person owns an old financial file.
- No new application runtime dependency was introduced. Security scanner gems were installed in a disposable `/tmp` directory; Python's existing development/Chronos environment was synchronized from its unchanged lockfile.

## Simplification and measured performance

| Change | Before | After | Evidence / interpretation |
|---|---:|---:|---|
| Startup application JS | 1,179.42 kB / 368.35 kB gzip | 913.97 kB / 290.31 kB gzip | Same Vite production build target. About 22.5% less main JS and 21.2% less gzip. Secondary workspaces load through React lazy/Suspense; total application code has not disappeared. |
| Dedupe candidates materialized | 20,150 | 100 | Synthetic history with relevant, unrelated, and unknown accounts. All incoming duplicate/review/new verdicts remain identical. Existing user/date indexes can serve the bounded query; no speculative index was added. |
| Candidate fetch example | 95.63 ms | 5.84 ms | One measured local run, not a production latency guarantee or an end-to-end import speed claim. Reproducible test: `test/services/finance/import_performance_test.rb`. |
| Custom-income category queries for 400 import rows | One lookup per row | 1 | ImportPlan supplies a cached category set to the common classifier. The regression checks both query count and all 400 financial kinds. |
| Profile lookups when exporting 25 manual rows | One lookup per manual row | 0 additional | The Report already owns the profile. Query instrumentation checks reuse and correct currency. |
| Summary requests for a changed cloud version | 2 | 1 | `syncFromWeb` passes its known summary into the downloader. |

Removed the unsafe legacy-adoption branch/helper and separate refund link mutation steps. Kept one classification implementation with an optional cached lookup rather than duplicating its rules. Vitest's security upgrade removed eight net packages from the client install at that step. No bulk stylistic rewrite, framework replacement, or unrelated repository cleanup was performed.

## Dependency and security verification

- Client: Vitest `3.2.7` → `4.1.12`; compatible with the installed Node 24 and Vite 7. The client `npm audit --package-lock-only` reports **0 vulnerabilities** afterward. Relevant upstream advisories: [Vitest mock boundary](https://github.com/advisories/GHSA-82fw-gwwq-j7x9), [Tinypool worker options](https://github.com/advisories/GHSA-5gmw-xhrv-c9v3).
- Ruby: 25 advisory entries across eight gems were reported initially. Conservative updates retain the existing major versions: addressable 2.9.2, Avo 3.33.4, css_parser 3.4.0, msgpack 1.8.7, OmniAuth 2.4.1, Puma 8.1.1, Rack 3.2.8, ViewComponent 4.24.0. Avo is constrained to its patched 3.33 line. `bundle-audit check` reports **No vulnerabilities found**. [Avo authorization advisory](https://github.com/avo-hq/avo/security/advisories/GHSA-x65r-p6hf-94hv).
- Rails asset/tooling Yarn tree: re-resolved vulnerable packages within existing dependency ranges, with install scripts disabled. Audit entries decreased **75 → 38**, including deprecated-package notices. **Three critical advisory entries remain**, in pinned Handlebars and tar trees reached through documentation/native-build tooling. No claim of a completely clean repository dependency tree is made. Forcing new major versions into parents' pinned dependencies without validating those tools would risk compatibility. Both Rails JS and CSS asset builds execute after the safe refresh.
- Brakeman: 2 warnings initially → 1 weak-confidence HTTP-verb warning; no medium/high-confidence warning remains in the final scan. This is static analysis, not proof that every security issue is absent.
- Authentication/token expiry, authorization scoping, upload validation, SQL placeholders, CSV formula escaping, CSP/permissions, forecast configuration, and privacy filters were inspected. No deployment headers, production configuration, mobile device security, Rust advisory database, or Python dependency vulnerability database is claimed as exhaustively verified.

## Test and validation ledger

Final verification is complete. [Verification record](evidence/2026-11-16/verification.txt); [Chromium screenshot](evidence/2026-11-16/chromium-smoke.png).

**Final Rails result: 650 tests, 24,969 assertions, 0 failures, 0 errors, 2 existing skips (648 passed).** This final full run includes all Ruby changes, current dependency locks, the corrected account-assignment contract assertions, and the new financial/privacy/performance regressions. Coverage: 95.39% (5,756 / 6,034 lines). The default Rails command does not include browser system/scaffolding suites.

**Final client result: 58 files, 689 passed, 0 failures.** TypeScript/production build, 15 Rust tests, 55 Python tests, both loopback Chromium smoke runs, Rails JS/CSS builds, modified Ruby syntax and diff whitespace checks pass. StandardRB retains exactly three pre-existing test-style findings, verified against HEAD; no unrelated style rewrite was made. Brakeman retains one weak warning, not a clean-scan claim.

- Initial client baseline: **55 files, 672 tests passed**, 88.51 seconds; baseline production build passed.
- Initial full Rails run: **637 tests, 1 failure, 0 errors, 2 skips**. This was started before edits but overlapped early fixes during asset preparation, so it is not claimed as a pristine commit-only comparison. The failure was the timezone mismatch described above.
- Intermediate client runs exposed asynchronous page-test assumptions after lazy loading, increased worker contention, and an upload assertion missing the new evidence fields. Tests now await actual controls, maintain the new explicit contract, and use two workers with realistic UI wait/test budgets. The existing 20,000-row import performance bound was not relaxed.
- Intermediate Rails runs caught stale account/timestamp assertions and a regression fixture incorrectly using a manual entry for an imported-entry normalization case. The fixture now exercises the actual vulnerable imported path. Failed runs are not counted as successful verification.
- Latest full client run before delivery: **58 files, 689 passed**, including shared packages, real Apple Vision, real Tesseract in Node and Chromium, 20,000-row overlapping imports, privacy guards, and UI flows. Final ownership confirmation regressions: **34 passed**; a full run after that policy passed **687**, then the final backup edge cases brought the successful delivery run to **689**.
- Forecasting: **55 passed** via `.venv/bin/python -m pytest -q`, synthetic/fake forecasting tests; no claim of testing production Chronos models or service infrastructure.
- Rust: **15 passed** on this macOS host. The initial cache referenced a previous absolute project location; rebuilding only the OCR plugin's cached artifacts resolved it. No native app with real databases was launched.
- Chromium: `node clients/universal/scripts/audit-smoke.mjs` against a loopback Vite server passes manual accounts, expense, linked refund, $950 net worth, mode switching, and lazy-loaded Reports. Every external request is intercepted; no live account or real financial data is used. Screenshot retained under the evidence directory.
- Client TypeScript and production build, Rails JS/CSS builds, modified Ruby syntax, and `git diff --check` are part of final verification. StandardRB results distinguish pre-existing style findings from newly introduced code.

### Reproduction commands

Run from the repository root unless noted. Never let Rails fall back to the development environment's database URLs.

```sh
env PATH=/Users/jyunz/.local/share/mise/installs/ruby/4.0.3/bin:$PATH \
  RAILS_ENV=test \
  DATABASE_URL=postgresql://localhost/billieweather_codex_audit_test \
  DATABASE_URL_UNPOOLED=postgresql://localhost/billieweather_codex_audit_test \
  OPENAI_API_KEY= BILLIEFORECAST_URL= bin/rails test

cd clients/universal
npm test
npm run build
npm audit --package-lock-only
# Start Vite on 127.0.0.1:14820 in another terminal, then:
node scripts/audit-smoke.mjs
cd src-tauri
cargo test --locked

# From billieforecast/ with the existing locked dev environment:
.venv/bin/python -m pytest -q
```

## Remaining risks and prioritized follow-up

1. **Local text-PDF fallback still lacks account-aware row deduplication.** CSV/OCR universal imports and Rails imports have row-level overlap checks; the separate text-PDF import uses file hashes. It also loses account identity before storage. Automatically dropping rows from different unidentified accounts risks deleting legitimate purchases. Unify this path with the reviewed account-aware pipeline rather than guessing ownership/account identity or silently rewriting existing records.
2. **Cloud copies/transfers are statement copies, not complete ledger synchronization.** Explicit kind and original bank text are now preserved, but accounts, books, links, dimensions, manual/recurring entries, and full provenance do not all travel through this contract. A verified backup is the full-fidelity path. Multiple web books and truly complete synchronization need a separate versioned contract and migration plan.
3. **Multi-statement local merges and multi-table logical backups lack a single consistent database transaction.** The Tauri SQL driver pools connections. Existing trigger-based imports and the changed refund writes are atomic; other staged operations/audit writes may still be interrupted. Counts, schema validation, foreign keys, and checksum verification detect many failures, but do not establish point-in-time consistency under all concurrent writes.
4. **Three critical root tooling advisory entries remain**, plus other root Yarn warnings. Isolate/upgrade documentation and native-build toolchains with their own compatibility checks; do not confuse the clean client npm audit and Ruby audit with this separate tree.
5. **Legacy classifications and already-lost bank evidence require user review/source re-import.** No real records were opened or changed. Do not auto-correct historical totals from uncertain descriptions.
6. Web credit-card single-amount sign conventions still need parity with the universal client's explicit confirmation. PostgreSQL cross-reference ownership still relies largely on scoped services/model validation rather than composite database foreign keys.
7. The Rails CSP initializer is a commented template; effective production proxy/header behavior was not inspected. Tauri file scopes and native OS protections deserve device-level verification. Local SQLite is not independently encrypted at rest by this change; encrypted exported backups remain optional.
8. Browser smoke testing does not replace macOS packaged-app, Windows, iOS, or Android device testing. Production migrations, Neon branch rehearsal, Render deployment, pushes, and commits remain deliberately unperformed.

## Changed-file inventory

All paths below are local reviewable changes. No environment/secret file or production schema was changed.

| File | Purpose |
|---|---|
| [Gemfile](../../Gemfile) | Compatible Ruby security upgrades and patched Avo version line |
| [Gemfile.lock](../../Gemfile.lock) | Compatible Ruby security upgrades and patched Avo version line |
| [app/controllers/client_api/v1/finance_controller.rb](../../app/controllers/client_api/v1/finance_controller.rb) | Validate incoming financial kind, evidence and row shape |
| [app/controllers/client_api/v1/local_databases_controller.rb](../../app/controllers/client_api/v1/local_databases_controller.rb) | Explicit request allowlist without permit! |
| [app/helpers/application_helper.rb](../../app/helpers/application_helper.rb) | Handle HEAD consistently with GET for language navigation |
| [app/models/finance/statement.rb](../../app/models/finance/statement.rb) | Keep ledger account references consistent with statement reassignment |
| [app/services/finance/duplicate_detector.rb](../../app/services/finance/duplicate_detector.rb) | Account/date-bounded dedupe, cached classification and preserved source decisions |
| [app/services/finance/entry_classifier.rb](../../app/services/finance/entry_classifier.rb) | Account/date-bounded dedupe, cached classification and preserved source decisions |
| [app/services/finance/import_plan.rb](../../app/services/finance/import_plan.rb) | Account/date-bounded dedupe, cached classification and preserved source decisions |
| [app/services/finance/ledger.rb](../../app/services/finance/ledger.rb) | Refund lifecycle invariants and correct batch/tag undo |
| [app/services/finance/report.rb](../../app/services/finance/report.rb) | Reuse report profile rather than query per manual row |
| [clients/universal/package-lock.json](../../clients/universal/package-lock.json) | Patched Vitest dependency tree |
| [clients/universal/package.json](../../clients/universal/package.json) | Patched Vitest dependency tree |
| [clients/universal/scripts/audit-smoke.mjs](../../clients/universal/scripts/audit-smoke.mjs) | Reproducible synthetic Chromium dev/production smoke test |
| [clients/universal/src-tauri/migrations/0008_refund_integrity.sql](../../clients/universal/src-tauri/migrations/0008_refund_integrity.sql) | Additive SQLite refund integrity guards and atomic relinking |
| [clients/universal/src-tauri/src/lib.rs](../../clients/universal/src-tauri/src/lib.rs) | Register schema 8 and fail startup when pre-migration protection fails |
| [clients/universal/src/App.tsx](../../clients/universal/src/App.tsx) | Identity-safe provider gate and lazy page loading |
| [clients/universal/src/components/BackupPanel.tsx](../../clients/universal/src/components/BackupPanel.tsx) | Handle restore errors and concurrent clicks |
| [clients/universal/src/hooks/useAccount.tsx](../../clients/universal/src/hooks/useAccount.tsx) | Bind cloud token access to the verified account identity |
| [clients/universal/src/hooks/useFinance.tsx](../../clients/universal/src/hooks/useFinance.tsx) | Explicit legacy ownership confirmation and safe snapshot adoption |
| [clients/universal/src/services/backup.ts](../../clients/universal/src/services/backup.ts) | Validated restore boundary, cents/schema/FK checks and safe target handling |
| [clients/universal/src/services/cloudUpload.ts](../../clients/universal/src/services/cloudUpload.ts) | Preserve explicit kinds/source text and reject incomplete download sequences |
| [clients/universal/src/services/databases.ts](../../clients/universal/src/services/databases.ts) | Remove unsafe automatic legacy adoption helper |
| [clients/universal/src/services/ledger.ts](../../clients/universal/src/services/ledger.ts) | Atomic local refund edit/relink and undo support |
| [clients/universal/src/services/store.ts](../../clients/universal/src/services/store.ts) | Preserve financial evidence in copies and detect all occupied financial slots |
| [clients/universal/src/services/transfer.ts](../../clients/universal/src/services/transfer.ts) | Preserve explicit kinds/source text and reject incomplete download sequences |
| [clients/universal/src/services/webSync.ts](../../clients/universal/src/services/webSync.ts) | Preserve explicit kinds/source text and reject incomplete download sequences |
| [clients/universal/test/backup.test.ts](../../clients/universal/test/backup.test.ts) | Financial/security/performance regression or explicit asynchronous/ownership fixture contract |
| [clients/universal/test/categoriesPage.test.tsx](../../clients/universal/test/categoriesPage.test.tsx) | Financial/security/performance regression or explicit asynchronous/ownership fixture contract |
| [clients/universal/test/dataPage.test.tsx](../../clients/universal/test/dataPage.test.tsx) | Financial/security/performance regression or explicit asynchronous/ownership fixture contract |
| [clients/universal/test/manualBookkeeping.test.tsx](../../clients/universal/test/manualBookkeeping.test.tsx) | Financial/security/performance regression or explicit asynchronous/ownership fixture contract |
| [clients/universal/test/manualMode.test.tsx](../../clients/universal/test/manualMode.test.tsx) | Financial/security/performance regression or explicit asynchronous/ownership fixture contract |
| [clients/universal/test/ownerBinding.test.tsx](../../clients/universal/test/ownerBinding.test.tsx) | Financial/security/performance regression or explicit asynchronous/ownership fixture contract |
| [clients/universal/test/pdfReviewPage.test.tsx](../../clients/universal/test/pdfReviewPage.test.tsx) | Financial/security/performance regression or explicit asynchronous/ownership fixture contract |
| [clients/universal/test/refundIntegrity.test.ts](../../clients/universal/test/refundIntegrity.test.ts) | Financial/security/performance regression or explicit asynchronous/ownership fixture contract |
| [clients/universal/test/regionDetection.test.tsx](../../clients/universal/test/regionDetection.test.tsx) | Financial/security/performance regression or explicit asynchronous/ownership fixture contract |
| [clients/universal/test/regionUi.test.tsx](../../clients/universal/test/regionUi.test.tsx) | Financial/security/performance regression or explicit asynchronous/ownership fixture contract |
| [clients/universal/test/reportingUi.test.tsx](../../clients/universal/test/reportingUi.test.tsx) | Financial/security/performance regression or explicit asynchronous/ownership fixture contract |
| [clients/universal/test/setup.ts](../../clients/universal/test/setup.ts) | Financial/security/performance regression or explicit asynchronous/ownership fixture contract |
| [clients/universal/test/snapshotOwnership.test.tsx](../../clients/universal/test/snapshotOwnership.test.tsx) | Financial/security/performance regression or explicit asynchronous/ownership fixture contract |
| [clients/universal/test/transferIntegrity.test.ts](../../clients/universal/test/transferIntegrity.test.ts) | Financial/security/performance regression or explicit asynchronous/ownership fixture contract |
| [clients/universal/test/uiHelpers.ts](../../clients/universal/test/uiHelpers.ts) | Financial/security/performance regression or explicit asynchronous/ownership fixture contract |
| [clients/universal/test/workflow.test.tsx](../../clients/universal/test/workflow.test.tsx) | Financial/security/performance regression or explicit asynchronous/ownership fixture contract |
| [clients/universal/vite.config.ts](../../clients/universal/vite.config.ts) | Bound memory-heavy test workers and configure asynchronous UI setup |
| [config/initializers/filter_parameter_logging.rb](../../config/initializers/filter_parameter_logging.rb) | Redact private financial/automation payloads from parameter logs |
| [docs/architecture/finance-domain-spec.md](../../docs/architecture/finance-domain-spec.md) | Document explicit legacy ownership confirmation |
| [docs/audits/codex-independent-engineering-audit-2026-11-16.md](../../docs/audits/codex-independent-engineering-audit-2026-11-16.md) | Independent audit, decisions, limitations and file inventory |
| [docs/audits/evidence/2026-11-16/chromium-smoke.png](../../docs/audits/evidence/2026-11-16/chromium-smoke.png) | Retained synthetic verification evidence |
| [docs/audits/evidence/2026-11-16/verification.txt](../../docs/audits/evidence/2026-11-16/verification.txt) | Retained synthetic verification evidence |
| [test/integration/client_api_finance_test.rb](../../test/integration/client_api_finance_test.rb) | Financial/security/performance regression or explicit asynchronous/ownership fixture contract |
| [test/integration/finance_account_balances_test.rb](../../test/integration/finance_account_balances_test.rb) | Financial/security/performance regression or explicit asynchronous/ownership fixture contract |
| [test/integration/finance_manual_bookkeeping_test.rb](../../test/integration/finance_manual_bookkeeping_test.rb) | Financial/security/performance regression or explicit asynchronous/ownership fixture contract |
| [test/integration/finance_parameter_logging_test.rb](../../test/integration/finance_parameter_logging_test.rb) | Financial/security/performance regression or explicit asynchronous/ownership fixture contract |
| [test/services/finance/duplicate_import_test.rb](../../test/services/finance/duplicate_import_test.rb) | Financial/security/performance regression or explicit asynchronous/ownership fixture contract |
| [test/services/finance/import_performance_test.rb](../../test/services/finance/import_performance_test.rb) | Financial/security/performance regression or explicit asynchronous/ownership fixture contract |
| [test/services/finance/ledger_test.rb](../../test/services/finance/ledger_test.rb) | Financial/security/performance regression or explicit asynchronous/ownership fixture contract |
| [yarn.lock](../../yarn.lock) | Compatible Rails asset/tooling security refresh |
