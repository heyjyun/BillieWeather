# BillieWeather / FinRx — Phase 0.5 + Phase 1a Implementation Report

Date: 2026-11-23 · Branch: `phase-1a-modular-shell` (local only, from `main` @ `e4380af`) · **Not committed, not pushed, not deployed.**
Starting point: [phase0-modular-platform-audit-2026-11-23.md](phase0-modular-platform-audit-2026-11-23.md).

Evidence labels distinguish automated tests **[tested]**, observed browser UI **[GUI]**, and observed native macOS UI **[native GUI]**. See §18 for the final acceptance results.

---

## 1. Executive Summary

**Phase 0.5 is done:**
- The five known Rails failures are fixed.
- The three audited defects (R1 account deletion, R2 upload validation, R3 AI categorization without audit or undo) are fixed and have regression tests.
- Two more real HTTP 500s were found in the client API and fixed.
- The local app's AI categorization had the same audit and undo gap; it is now fixed the same way.

**Phase 1a is done locally on both surfaces (Rails website and the universal React/Tauri client):**
- A shared module catalog: one JSON file, read by Ruby and TypeScript, with a shared contract fixture.
- Settings › Feature Library, with Available and Coming soon states and filters.
- The new default sidebar for everyone: Transactions · AI Assistant · Settings.
- Persistent preferences:
  - Website: a new additive table, `finance_module_preferences`.
  - App: local storage per account.
- A safe "this module is off" page for direct links.
- Transactions sections: Overview / All Transactions / Add & Sync.

**Decision 3 (receipts) is implemented in the server reconciler:**
- Receipts are never turned into new transactions automatically.
- Linking automatically to an existing transaction requires an exact, unambiguous, deterministic match and a confident extraction.

**Default / Manual modes still work** (Decision 2). The sidebar no longer depends on the mode.

**Initial implementation regression results** (baseline in §11 and final rerun in §18.4):

| Suite | Result |
|---|---|
| Rails | 803 tests, 0 failures (was 755 tests, 5 failures) |
| Universal client (vitest) | 897 passed, 12 skipped (was 872 passed) |
| Typecheck | clean |

**What Phase 1a does not do:**
- Cross-device preference sync (Phase 1b). The website and the app keep separate choices today, and the UI says so.
- Final acceptance passed on a separately initialized local PostgreSQL cluster and a separate native macOS bundle. The existing development services on ports 3000 and 8100 are configured for Neon `production`. See §18 for the migration, native acceptance and regression results.

---

## 2. Phase 0.5 Fixes

### 2.1 Account deletion with receipts (R1) — fixed, non-destructive
- Cause (confirmed): `fk_finance_receipts_bank_account_id_owner` has no ON DELETE action (`db/schema.rb`). Deleting an account that a receipt points at therefore raised `ActiveRecord::InvalidForeignKey`, which became a 500.
- Fix, in [accounts_controller.rb:96-113](../../app/controllers/finance/accounts_controller.rb#L96-L113):
  - An account with receipts is refused with an actionable message (`billie.ledger.accounts.in_use_receipts`, 6 languages): "archive it instead; the receipts stay".
  - The delete and its audit event now run in one transaction.
  - A defensive `rescue ActiveRecord::InvalidForeignKey` turns any later race into the same "in use" message.
- Nothing cascades; the schema is unchanged.
- I also checked user deletion: it is safe, because `AccountDeletion` runs `Finance::DataDeletion` first, and that deletes receipts before accounts.
- Tests: [finance_account_deletion_test.rb](../../test/integration/finance_account_deletion_test.rb) (3 tests: refused with receipt, unused account still deleted and audited, FK race → message). **[tested]**

### 2.2 AI categorization: audit and undo (R3) — fixed on the website and in the app
- **Website.** New `Ledger#apply_ai_categories` ([ledger.rb:158-198](../../app/services/finance/ledger.rb#L158-L198)), called by [ai_categorizer.rb:172-181](../../app/services/finance/ai_categorizer.rb#L172-L181).
  - It reuses the existing audit infrastructure: `finance_audit_events`, actor `ai`, action `ai_apply`, one `batch_id`.
  - It runs inside the person's row lock and a single transaction, so it is all or nothing.
  - Only rows that are still automatic (Uncategorized and not locked) are changed.
  - Only the changed classification fields are logged (`category`, `category_source`, `category_model`, `kind`, `tax_review`). No amounts, dates or descriptions.
- **Undo** reuses the existing `Ledger#undo_batch`, which skips any row whose values changed since the batch. A person's later edit is never overwritten. The Activity page already offered Undo for `ai_apply` batches. The Categories page now also shows "Undo this AI run" right after a run (`#ai-undo`).
- **Side fix.** The layout used to render every flash key, so the batch id would have appeared as a text banner. It now renders only `notice` and `alert` ([billie.html.erb:80](../../app/views/layouts/billie.html.erb#L80)).
- **App (same class of defect).**
  - `FinanceStore.applyAiCategoriesBatch` ([store.ts:356](../../clients/universal/src/services/store.ts#L356)) writes one audited `ai_apply` batch in one SQLite transaction.
  - Undo steps can now carry `expect`. `LedgerStore.runUndo` ([ledger.ts:311](../../clients/universal/src/services/ledger.ts#L311)) skips a step when the row changed since. Old steps without `expect` behave as before.
- Tests:
  - Website: [ai_categorization_audit_test.rb](../../test/services/finance/ai_categorization_audit_test.rb) (6 tests: audit contents, undo, conflict, failure part-way with nothing written, locked rows, empty run), plus an integration check in `finance_categories_test.rb`.
  - App: 3 new tests in `categories.test.ts`. **[tested]**

### 2.3 Statement upload validation (R2) — fixed, plus adjacent defects
- Finding: the exact audited case (a malformed sha256) was **already a 422** with the generic code `invalid`, because `Finance::Statement` validates the format.
- Probing adjacent inputs found two **real 500s**:
  - a `statement` payload that is a string or array → `TypeError`;
  - receipt `lines` given as strings, or `fields` that are not an object → `NoMethodError`.
- Fix, in [finance_controller.rb:65-80, 113-127](../../app/controllers/client_api/v1/finance_controller.rb#L65-L127):
  - The payload shape is checked first.
  - `sha256` must be lower-case hex, exactly 64 characters (`invalid_sha256`), the same rule as the model and the database CHECK.
  - `transactions`, `currency` and `filename` types are checked.
  - The closing balance must be finite, have at most 2 decimals, and fit the column; its date must be ISO.
- Fix, in [receipts_controller.rb:64-78](../../app/controllers/client_api/v1/receipts_controller.rb#L64-L78): `lines_invalid` and `fields_invalid` are now 422s.
- The client only looks at the HTTP status, so it is unaffected.
- Tests: [client_api_upload_validation_test.rb](../../test/integration/client_api_upload_validation_test.rb) (5 tests, about 30 malformed inputs; each one asserts that nothing was written). **[tested]**

### 2.4 The five baseline Rails failures — fixed without weakening assertions
- **4 × `privacy_data_deletion_test`.** The seed now creates a Receipt, a ReceiptMatch and a CaptureToken, so the "all or nothing" assertions also cover receipt data. The assertions themselves are unchanged.
- **1 × localization.** Added `config/locales/billie_receipts.es.yml`: 277 keys, tú form, same terms as `billie_ledger.es.yml` and the app's `receipt.ts`. The key and interpolation parity test passes.

### 2.5 Decision 3 — receipt matching and review (server)
- [receipt_reconciler.rb](../../app/services/finance/receipt_reconciler.rb):
  - `process` no longer calls `record!` automatically.
  - "Keep separate" no longer records anything either.
  - An exact match is linked automatically only when `auto_link_allowed?` holds ([receipt_reconciler.rb:276](../../app/services/finance/receipt_reconciler.rb#L276)): the receipt is complete, the extraction is confident or confirmed by a person, the currency is the book's, and the receipt is not already linked. This sits on top of the shared deterministic matcher. The matcher already refuses: other currencies, rows that already have a receipt, transfers, and rival candidates (downgraded to ambiguous or probable). No LLM score is involved.
- Everything else is suggested for review. A new entry is created only by the person's "Record as expense" (`record!`), through `Ledger#create` as before.
- `ReceiptMatcher` (Ruby/TS parity fixtures) is unchanged.
- Tests: `receipt_reconciliation_test.rb`.
  - 9 existing tests that relied on auto-recording now record explicitly. They first assert that nothing was recorded, and they keep every one-purchase-counts-once invariant (I-R1…I-R4).
  - 3 new Decision 3 tests: exact match links and creates nothing; exact candidate with a low-confidence total is only suggested; re-running reconciliation never records. **[tested]**
- The app never auto-linked or auto-recorded receipts; its review-before-save flow is unchanged.

---

## 3. Phase 1a Implementation

| Part | Website (Rails ERB) | App (React/Tauri) |
|---|---|---|
| Catalog | `Finance::ModuleCatalog` reads `packages/shared-types/schema/module-catalog.json` | `@billie/shared-types` `modules.ts` imports the same JSON |
| Preference rules | `ModuleCatalog.enabled?` / `normalize` | `isModuleEnabled` / `normalizePreferences` |
| Shared contract | `packages/shared-types/fixtures/module-preference-cases.json`, replayed by both (10 cases) | same |
| Storage | `finance_module_preferences` (new table) | `localStorage` key `billie.modules.v1:<ownerKey>` |
| Sidebar | `finance/shared/_module_nav.html.erb` | `App.tsx` `#module-nav` |
| Gate for hidden modules | `BaseController#require_enabled_module` → `feature_library/disabled` | `PAGE_MODULES` + `<ModuleDisabled>` |
| Feature Library | `/app/settings/features` (`FeatureLibraryController`) | `features` page (`FeatureLibrary.tsx`) |
| Transactions sections | `_transactions_tabs.html.erb` | `TRANSACTION_SECTIONS` in `App.tsx` |
| Add & Sync | `/app/add` (`AddSyncController`) | `addSync` page (`AddSync.tsx`) |
| AI Assistant | Insights + Tax preparation (tabs) | `Assistant.tsx` (command bar + AI categorization + link to website insights) |

---

## 4. Modified Files

**Website, new files:**
- Controllers: `app/controllers/finance/feature_library_controller.rb`, `app/controllers/finance/add_sync_controller.rb`.
- Models: `app/models/finance/module_catalog.rb`, `app/models/finance/module_preference.rb`.
- Views: `app/views/finance/feature_library/{show,disabled}.html.erb`, `app/views/finance/add_sync/show.html.erb`, `app/views/finance/shared/{_module_nav,_transactions_tabs,_module_tabs}.html.erb`.
- Migration: `db/migrate/20261123000100_create_finance_module_preferences.rb`.
- Locales: `config/locales/billie_modules.{en,zh-CN,zh-TW,ja,ko,es}.yml`, `config/locales/billie_receipts.es.yml`.

**Website, changed files:**
- Controllers: `base_controller.rb`, `accounts_controller.rb`, `categories_controller.rb`, `client_api/v1/finance_controller.rb`, `client_api/v1/receipts_controller.rb`.
- Services: `ledger.rb`, `ai_categorizer.rb`, `receipt_reconciler.rb`.
- Models and helpers: `user.rb` (association), `finance_helper.rb` (10 icons).
- Views: `layouts/billie.html.erb`, `categories/index.html.erb`, `settings/show.html.erb`.
- Config and schema: `config/routes.rb`, `db/schema.rb` (+1 table only), `billie_ledger.*.yml` and `billie_categories.*.yml` (1 new key each).
- Static assets: `public/billie.css`, `public/billie.js` (switch and filter enhancement), `public/billie-command.js` (regenerated by `build-web.mjs`; minifier renames only).

**Shared packages:**
- New: `packages/shared-types/{schema/module-catalog.json, fixtures/module-preference-cases.json, src/modules.ts}`.
- Changed: `packages/shared-types/src/index.ts`, `packages/design-tokens/src/tokens.ts` (13 icons), `packages/design-tokens/test/tokens.test.ts` (icon parity for every catalog icon).

**App, new files:** `src/hooks/useModules.tsx`, `src/services/modulePreferences.ts`, `src/i18n/modules.ts` (6 languages), `src/pages/{FeatureLibrary,AddSync,Assistant}.tsx`, `src/components/{AiCategorizePanel,ModuleDisabled,ModuleIcon}.tsx`.

**App, changed files:** `src/App.tsx`, `src/pages/{Categories,Planning,Settings}.tsx`, `src/services/{store,ledger,account}.ts`, `src/styles.css`, `src/i18n/{en,zh-CN,zh-TW,ja,ko,es}.ts`.

**Tests:**
- New (Rails): `test/integration/{finance_feature_library,finance_account_deletion,client_api_upload_validation}_test.rb`, `test/models/finance/module_catalog_test.rb`, `test/services/finance/ai_categorization_audit_test.rb`, `test/support/billie_modules.rb`.
- New (app): `clients/universal/test/{modules.test.ts, featureLibrary.test.tsx}`.
- Adjusted Rails tests, for the new navigation (no assertion was removed without an equivalent):
  - `billie_design_shell_test`: Statements is now a Transactions tab.
  - `finance_manual_mode_test`: the Manual Mode marker is `#manual-mode-badge`.
  - `finance_categories_test`: the module is named "Categories & Tags".
  - 11 classes that exercise optional modules sign people in with the modules turned on (`include BillieModules::SignInWithAllModules`).
- Adjusted app tests:
  - The shared `openInShell` helper follows the new paths.
  - `enableAllModulesByDefault` is used only in the 4 files that exercise optional modules.
  - `privacy.test.ts` allow-list: the AI endpoint is called from `AiCategorizePanel`. It is just as strict, and also pins which pages use the panel.

---

## 5. Database Changes

**PostgreSQL** (`db/migrate/20261123000100_create_finance_module_preferences.rb`), additive only:
```
finance_module_preferences(id, user_id NOT NULL → users ON DELETE CASCADE, module_key varchar(40) NOT NULL,
  enabled boolean NOT NULL, revision bigint NOT NULL DEFAULT 1, changed_at timestamptz NOT NULL, created_at, updated_at)
UNIQUE(user_id, module_key); CHECK(module_key ~ '^[a-z_]{2,40}$'); CHECK(revision > 0)
```
- No foreign key to or from any finance table. No backfill: no row means the catalog default.
- These are view preferences, not financial data, so "Delete my financial data" keeps them. Deleting the account removes them ([tested]).
- The initial implementation used `untitled_application_test_billieweather`. Final acceptance independently repeated apply → rollback → reapply on a new socket-only PostgreSQL cluster and verified populated synthetic records throughout. See §18.
- `schema.rb` was restored from git and only the new table and the version were added. The local Postgres dump would have rewritten unrelated CHECK expressions cosmetically.
- **Not applied to Neon (dev or production).**
- Rollback: `bin/rails db:rollback STEP=1` (drops the table; everyone falls back to the defaults; no financial row is touched).

**SQLite (app):** **no migration.** App preferences live in localStorage per account, not in a database slot, so switching between the 8 local databases does not change the navigation, and backup/restore is unaffected.

---

## 6. Feature Catalog

Source: `packages/shared-types/schema/module-catalog.json` (version 1, preference format 1).

| id | Default | Website | App | Website pages | App pages |
|---|---|---|---|---|---|
| transactions | on (core) | Available | Available | dashboard, transactions, statements, statement drafts, receipts, reconciliation, manual, entries, activity, reviews, add | dashboard, transactions, manual, import, receipt, addSync |
| ai_assistant | on (core) | Available | Available | insights (+chat), **tax preparation** | assistant |
| ledgers | off | Coming soon | Coming soon | — | — |
| accounts | off | Available | Available | accounts | accounts |
| categories | off | Available | Available | categories, lists (merchants/projects/tags) | categories, lists |
| budgets | off | Available | Available | budgets | planning (budgets section) |
| reports | off | Available | Available | ledger reports, export | reports |
| recurring | off | Available | Available | recurring | planning (schedules section) |
| goals | off | Coming soon | Coming soon | — | — |
| household | off | Coming soon | Coming soon | — | — |
| forecast | off | Available | **Coming soon** (no forecast in the app) | forecast | — |
| multi_currency | off | Coming soon | Coming soon | — | — |

- Settings is a system entry: always shown, never stored, cannot be turned off ([tested], both surfaces).
- System pages that are never gated:
  - Website: settings, feature library, profile, financial data, local devices, mode switch, command bar JSON, bank account rename, capture tokens.
  - App: settings, data, features.
- Tax preparation moved from its own sidebar link to an AI Assistant tab. It is AI-generated, and AI Assistant is on by default, so it stays one click away for everyone.

---

## 7. Navigation Architecture

- **Sidebar (both surfaces, both modes):** enabled modules in catalog order, a divider, then Settings. The Manual Mode badge shows above it when Manual is on.
- **Transactions tabs:**
  - Overview → dashboard.
  - All Transactions → transactions, entry edit, trash, activity, reviews. Sub-tab: Review & history.
  - Add & Sync → hub, with sub-tabs Statements / Receipts / Reconciliation on the website and Import statements / Scan & Capture / Manual bookkeeping in the app.
- **Other module tabs**, so pages that used to have their own sidebar link are not dead ends:
  - AI Assistant (web): Insights · Tax preparation.
  - Reports (web): Reports · Export.
  - Categories & Tags (web and app): Categories · Merchants & tags.
  - [tested] by "no dead ends" (web) and `featureLibrary.test.tsx` (app).
- **Hidden module, direct URL or deep link:** the "{Module} is turned off" page explains that nothing was changed and offers "Turn on {Module}".
  - Website: returns to the original URL. `return_to` accepts only `/app/...` paths; external and `//` targets are refused ([tested]).
  - It does not switch Manual Mode on ([tested], both surfaces).
  - Writes to a hidden module answer 403 and change nothing ([tested]).
- **Hidden ≠ forbidden:** authentication and per-user ownership checks still run ([tested]: another person's account is still a 404 after enabling).
- **Processing never stops:** recurring entries still post while Recurring & Bills is hidden ([tested]). Balance sync and receipt matching are unaffected.
- **Accessibility:**
  - Switches use `role="switch"` and `aria-checked`, and are labelled by name and description.
  - The active page uses `aria-current="page"`. The web tabs are a labelled `<nav>`; in the app they are `role="group"`, which keeps one navigation landmark.
  - Coming soon switches are `aria-disabled` / `disabled`.
  - Styles respect `prefers-reduced-motion` and `forced-colors`. On phones the app's bottom bar scrolls when many modules are on.
  - Colors come only from design tokens, in light and dark ([tested] by the existing "no hex colors" style test).

---

## 8. Feature Library Behavior

- Cards show: icon, name, description, Core badge, Available / Coming soon badge, a switch, and an "Open" link once the module is on.
- Filters: All · Enabled · Available · Coming soon.
  - Website: links that work without JavaScript; with JavaScript, they filter in place.
  - App: segmented buttons.
- **Website, without a reload:** a switch sends `PATCH /app/settings/features/:id` (JSON) and receives the newly rendered sidebar, which replaces `#module-nav`. Without JavaScript the same form posts and redirects ([tested]: JSON contract). The JavaScript itself was not exercised by an automated browser test (see §11).
- **App:** the switch updates React state and localStorage at once; the sidebar re-renders immediately ([tested]).
- Errors: unknown module → 404; Coming soon → 422 with a message; Settings is not a module → 404. Nothing is stored in any of these cases ([tested]).
- Each surface states where its choices are kept: "saved for your account on this website / on this device; the other keeps its own for now".

---

## 9. Existing User Migration Behavior (Decision 1)

- Everyone, new or existing, gets the approved default (Transactions + AI Assistant + Settings), because no preference row exists yet. No data migration or backfill is needed.
- Existing users' data is untouched and reachable:
  - Every former sidebar destination is either inside a default module (Statements, Receipts, Reconciliation, Manual, Entries, Activity, Reviews, Insights, Tax preparation) or one switch away in the Feature Library (Accounts, Categories/Lists, Budgets, Reports/Export, Recurring, Forecast).
  - [tested]: an existing user with data and a budget sees the new sidebar and a byte-identical finance fingerprint across toggles.
- Once a person changes a switch, that choice wins on every later launch (website: per account; app: per account on that device) ([tested]: across sign-out/sign-in on the web and across unmount/remount, i.e. a restart, in the app).
- **App side effect to know about:** whoever upgrades the app will see Accounts, Planning, Lists and Reports disappear from the sidebar until they turn those modules on. This is what Decision 1 asks for.

---

## 10. Cross-Platform Status

| Surface | Code | Automated tests | Real runtime |
|---|---|---|---|
| Website (Rails ERB) | implemented | Rails integration and model tests [tested] | [GUI] see §11 |
| macOS app | shared React code implemented | Vitest (jsdom, sql.js) [tested] | **PASS [native GUI]**: packaged Tauri/WKWebView, isolated sign-in, synthetic import and sync, module persistence and data integrity. See §18. |
| Windows | same code | same vitest | **[not verified]**: no Windows build or device |
| iOS / Android | same code | same vitest | **[not verified]**: native projects were never generated (`src-tauri/gen` has only `schemas/`). Not generated in this phase. |
| Browser preview of the app | same code | — | **[not verified]** (in-memory sql.js preview) |

---

## 11. Test Results

Baseline is the Phase 0 audit, same day.

| Suite | Command | Before | After |
|---|---|---|---|
| Rails | `RAILS_ENV=test bin/rails test test/integration test/models test/services test/controllers` (local Postgres test database) | 755 runs, **5 failures**, 0 errors, 2 skips | **803 runs, 30,891 assertions, 0 failures, 0 errors, 2 skips** |
| Universal client | `npx vitest run` (clients/universal) | 65 files / 872 passed / 12 skipped | **67 files passed, 1 skipped; 897 passed, 12 skipped, 0 failed** |
| TypeScript | `npx tsc --noEmit` | 0 errors | **0 errors** |
| Design tokens, NL engine and commands package tests | run inside vitest | included above | included above (incl. new icon parity and web-bundle freshness) |
| identity-api / billieforecast | — | 117 / 55 passing | **not re-run**: no file in those services changed |

- The 2 Rails skips are baseline Bullet Train scaffolding tests (`ability_test.rb:26`, `creative_concepts_controller_test.rb:23`). They are unrelated and unchanged.

**GUI check (website):** a headless Chromium, driven by the repo's `playwright-core`, ran against a separate `RAILS_ENV=test` server on port 3100. The user was a synthetic FactoryBot user with a synthetic CSV; that user and its data were deleted afterwards. Chrome DevTools MCP could not attach (no permission to read its port file), so a headless browser was used instead. **[GUI]**
- New user's sidebar: `Transactions · AI Assistant · Settings`. The Transactions tabs show Overview as active.
- Feature Library at 1280px: 12 cards with correct Available and Coming soon states. Dark mode and zh-CN render correctly.
- Clicking the Budgets switch saved the choice **without a page reload** (a page-level JS marker survived). The sidebar gained "Budgets", the switch shows `aria-checked=true`, and the status line read "Budgets is on and in your sidebar."
- The "Coming soon" filter shows exactly ledgers, goals, household and multi_currency.
- `/app/accounts` while the module was off showed "Accounts & Assets is turned off" with Turn on and Open Feature Library buttons.
- Add & Sync shows its 4 cards and the Statements / Receipts / Reconciliation sub-tabs.
- 390px phone: no horizontal overflow. **A real layout bug was found and fixed here:** the module list stacked vertically inside the phone's fixed bottom bar. It is now one 65px row with Settings last (`public/billie.css`, phone media query).
- Console errors: none.

**Native macOS GUI:** §18 records the signed-in acceptance on the isolated packaged build. §16.2 retains the earlier blocked attempt as historical evidence.

---

## 12. Known Limitations

1. **No cross-device preference sync (Phase 1b).** The website and each device keep their own choices. App choices are per account per device and are not backed up with the database.
2. **The existing development services target Neon production.** The existing Rails log contains `PendingMigrationError`. Final acceptance used dedicated local services and verified the migration there. Cloud validation requires a separately authorized isolated Neon target.
3. **Overview is the existing dashboard.** There is no redesign and no new charts (Phase 2). All Transactions is the existing page; Manual-only tools remain Manual-only (Decision 2).
4. **App AI Assistant is honest but thin:** command bar + AI categorization + a link to the website's insights and chat. There is no in-app chat yet.
5. **The Feature Library's no-reload JavaScript on the website** has a tested JSON contract, but no automated browser test.
6. **Forecast is web-only.** It is shown as Coming soon in the app.
7. **Comment inaccuracies from the audit (R7)** (`session_token.rb`, `client_api/base_controller.rb`, `finance_controller.rb` "no delete everything") were **not changed**. They were out of the approved Phase 0.5 list.
8. `docs/architecture/receipt-capture-and-reconciliation.md` is referenced in code but does not exist. The new receipt rule is documented in the reconciler header and in this report.
9. Website writes to a hidden module answer 403 with the "turned off" page. Background processing for hidden modules (recurring posting, receipt matching) intentionally continues.

---

## 13. Risks and Rollback

| Risk | Mitigation |
|---|---|
| Existing users feel features "disappeared" | Every page is one switch away; direct links show "Turn on" instead of a 404; the Settings page shows a Feature Library card first |
| Decision 3 changes the receipt-first flow: a confident receipt no longer counts until confirmed | Intended. Receipts stay in "needs review" and the reconciliation page lists them. Reverting is one method (`process`) plus the tests |
| Rails/TS rules drift apart | One JSON catalog plus a shared case fixture replayed by both; a controller-coverage test; an icon parity test |
| Deploying the code before migrating | Every finance page queries `finance_module_preferences`. Render's build already runs `db:migrate` (`render.yaml:13` → `bin/render-build.sh:15`), so a deploy would apply this additive migration; **only deploy with your approval** |

**Rollback:**
- All changes are uncommitted on branch `phase-1a-modular-shell`. `git stash` or a checkout of `main` reverts the code.
- The test database: `RAILS_ENV=test bin/rails db:rollback STEP=1`.
- No financial table or row was changed by any step. The app needs no SQLite rollback, because there is no SQLite migration.

---

## 14. Recommended Phase 1b Plan (cross-device preferences)

This section was the preliminary sketch in the implementation report. It is **superseded by the detailed design in §17**, which uses server revisions and optimistic concurrency control rather than relying on client timestamps or naive Last Write Wins. No Phase 1b code or migration has been implemented.

## 15. Recommended Phase 2 Plan (Transactions workspace)

- **2a, Overview:** comparison with the previous period (`compareSnapshot` in finance-core plus a Ruby parity fixture), income by category, an account filter, an SVG cash-flow trend (no chart library), and better empty states. Reuse `Snapshot`, `DashboardPeriod` and `spendingMix`.
- **2a, All Transactions:** sorting (and an index if needed), manual transfer and refund linking UI (existing `ledger.linkTransfer` / `linkRefund`), a column chooser. Decide with you whether Manual-only actions become available in Default Mode; that question is still deferred.
- **2b, split transactions:** a separate design review first (schema plus refund/transfer invariants).
- **2c:** AI Assistant chat in the app via the server (consented, aggregates only, as on the website), and AI writes through the reviewable command executor.

---

## 16. Earlier Phase 1a Validation Attempt (2026-11-23)

Historical record of the first attempt, including the synthetic identity incident below. §18 contains the current acceptance decision. All commands below were run from the repository root unless a client directory is shown.

### 16.1 Isolated Neon target and migration validation

| Check | Result | Evidence |
|---|---|---|
| Identify the current Neon target | **PASS** | `.env.local` has `NEON_BRANCH=production`, `NEON_BRANCH_ID=br-damp-sea-bd1swyfw`; the connection host is the project’s `aws-us-east-2` endpoint. `neon projects list` identified project `sparkling-sun-34139417` (`BillieWeather`), and `neon branches list` identified `production` as the default/primary branch. |
| Confirm that the current target is isolated | **FAIL** | It is the default `production` branch, not an isolated validation branch. The running Rails process on port 3000 uses this Neon target. |
| Create/use an isolated Neon cloud branch | **BLOCKED** | Neon CLI authentication was available, but the project output did not expose a verifiable plan/cost boundary. Creating a branch with a read-write compute could incur uncertain cloud cost and would be an external resource write. No branch was created, and no Neon branch was modified. |
| Apply the Phase 1a migration to Neon dev/production | **BLOCKED** | Not attempted because the only configured target is `production` and no safe isolated branch was available. This preserves the user’s explicit no-modification boundary. |
| Local isolated migration up/down/up | **PASS** | Local test database `untitled_application_test_billieweather`; `env -u DATABASE_URL -u DATABASE_URL_UNPOOLED RAILS_ENV=test /Users/jyunz/.local/share/mise/installs/ruby/4.0.3/bin/ruby bin/rails db:rollback STEP=1`, then `db:migrate`, then a second `db:migrate` no-op. |
| Preserve representative records | **PASS** | Before rollback and after migrate, all `finance_*` table counts were identical (0 rows in this disposable test DB) and `users=1`. The migration-specific tests use synthetic users, a synthetic CSV, a synthetic budget, preferences, and recurring data. |
| Verify resulting schema | **PASS** | `db/migrate/20261123000100_create_finance_module_preferences.rb:11-23`; the resulting table had the expected primary key, `user_id` foreign key with `ON DELETE CASCADE`, unique `(user_id,module_key)` index, key-format check, positive-revision check, and non-null columns. The schema snapshot is recorded in `db/schema.rb:358-369,967`. |
| Verify rollback behavior | **PASS** | Rollback dropped only `finance_module_preferences`; after rollback all other `finance_*` counts and `users` count were unchanged. Re-migrate recreated the table. Rollback command: `RAILS_ENV=test bin/rails db:rollback STEP=1`. |
| Verify unrelated financial objects | **PASS** | The migration has no foreign key to or from a finance table (`db/migrate/20261123000100_create_finance_module_preferences.rb:6,14`); the before/after count comparison showed no changes to other finance tables. |

The Neon cloud migration remains intentionally pending. No financial tables, financial rows, backups, or existing user financial records were modified. During the native GUI smoke attempt, the local identity service was discovered to use the same Neon project; its disposable synthetic registration therefore temporarily created one identity/user row. Before completing this validation, I verified that user had zero rows in every `finance_*` table and removed only the exact synthetic `public.users`, `public.memberships`, and `identity.email_verifications` rows in one transaction. A final exact-email query returned zero rows. This cleanup is recorded because it means the strict “do not modify Neon” boundary was briefly crossed by synthetic identity setup, although no financial data was touched.

### 16.2 Native macOS GUI validation

| Check | Result | Evidence |
|---|---|---|
| Launch a separate native instance | **PASS** | Built and launched a disposable QA `.app` under `clients/universal/src-tauri/target/debug/bundle/macos/BillieWeather QA.app` with identifier `com.billieweather.qa`; it used a separate Vite port 1421 and separate app/keychain identity. The installed `BillieWeather` application was not replaced or modified. The QA app and mounted QA disk image were stopped/detached after inspection. |
| Real macOS window rendered | **PASS** | Accessibility tree identified a real `BillieWeather` window and native macOS controls, not a jsdom or browser snapshot. |
| Open signed-in shell and verify modules | **BLOCKED** | The disposable account registration page rendered and account creation succeeded, but sign-in returned “出了点问题，请重试。” because the QA app’s API was port 3000, whose current server points at the un-migrated Neon `production` target. Retrying by changing the installed app or running the production migration would violate the execution boundary. Therefore the signed-in sidebar, Feature Library, Transactions tabs, persistence, themes, language switching, and module toggles were not claimed as native-GUI verified. |
| Native Default / Manual behavior | **BLOCKED** | Requires the signed-in shell; the existing jsdom tests are not equivalent to native GUI validation. |
| Native financial-data preservation after disabling a module | **BLOCKED** | Requires signed-in native data and was not simulated against real or shared financial data. |

The exact blocker is environmental: the only available Rails API target for the native client is the user’s active port-3000 service backed by Neon `production`, and the Phase 1a migration cannot be run there under the stated authorization. The signed-out native registration/login UI was observed, but no success is inferred for the blocked checks. The disposable synthetic identity used for the smoke attempt was cleaned up afterward; no financial rows existed for it.

### 16.3 Feature completeness and regression review

| Area | Result | Evidence |
|---|---|---|
| Accounts | **PASS** | `test/integration/finance_accounts_overview_test.rb`; hidden-module ownership and re-enable flow in `test/integration/finance_feature_library_test.rb:127-165`. |
| Planning / recurring | **PASS** | `clients/universal/src/pages/Planning.tsx`; recurring background posting test `test/integration/finance_feature_library_test.rb:167-175`; Manual-mode coverage in `test/integration/finance_manual_mode_test.rb`. |
| Lists / Categories | **PASS** | `clients/universal/src/pages/Lists.tsx`, `Categories.tsx`; category regression coverage in `test/integration/finance_categories_test.rb`. |
| Reports | **PASS** | `test/integration/finance_report_export_test.rb`; module route mapping in `packages/shared-types/schema/module-catalog.json:49-52`. |
| Transactions | **PASS** | `app/views/finance/shared/_transactions_tabs.html.erb:1-11`, `clients/universal/src/App.tsx:56-65`; Feature Library integration test covers Overview, All Transactions, and Add & Sync paths. |
| AI Assistant | **PASS** | `clients/universal/src/pages/Assistant.tsx`, `test/integration/finance_categories_test.rb:109-198`, and app tests in `clients/universal/test/featureLibrary.test.tsx` / `manualMode.test.tsx`. |
| Tax Preparation | **PASS** | Reachability from Insights is asserted at `test/integration/finance_feature_library_test.rb:213-218`; workflow and consent coverage is in `test/integration/finance_workflow_test.rb:342-415`. |
| Import Statements | **PASS** | Add & Sync links and import path asserted at `test/integration/finance_feature_library_test.rb:177-190`; upload validation coverage in `test/integration/client_api_upload_validation_test.rb`. |
| Scan & Capture | **PASS** | Add & Sync links to receipts and reconciliation at `test/integration/finance_feature_library_test.rb:177-190`; receipt regression suite passed. |
| Quick Add | **PASS** | Add & Sync exposes the existing entry path and explicitly marks the capability as later/unsupported; no misleading connection controls are rendered (`finance_feature_library_test.rb:177-186`). |
| Coming Soon behavior | **PASS** | `finance_feature_library_test.rb:100-115`; `module-catalog.json:25-29,61-82`; coming-soon switches have no submit form and server attempts return 422. |
| Default / Manual mode | **PASS** | `finance_feature_library_test.rb:37-51`; `finance_manual_mode_test.rb` (7 tests). The sidebar is independent of mode and existing records remain. |
| Account/data isolation | **PASS** | `finance_feature_library_test.rb:156-165`, `finance_account_deletion_test.rb`, and receipt cross-user tests. |
| Localization and themes | **PASS** | Existing Rails localization/manual-mode tests passed; prior website GUI evidence verified dark mode and zh-CN. Native macOS light/dark and English/Chinese were **BLOCKED** with the signed-in native shell. |

### 16.4 Regression test execution

The following commands were executed with the project Ruby 4.0.3 runtime because the system Ruby 2.6 cannot load the repository’s Bundler 4.0.24 lockfile:

```text
clients/universal: npm test -- --reporter=dot
  67 test files passed, 1 skipped; 897 passed, 12 skipped, 0 failed.

clients/universal: npm run typecheck
  PASS (tsc --noEmit; 0 errors).

Rails targeted regression:
RB=/Users/jyunz/.local/share/mise/installs/ruby/4.0.3/bin/ruby
env -u DATABASE_URL -u DATABASE_URL_UNPOOLED RAILS_ENV=test "$RB" bin/rails test \
  test/models/finance/module_catalog_test.rb \
  test/integration/finance_feature_library_test.rb \
  test/integration/finance_account_deletion_test.rb \
  test/integration/finance_manual_mode_test.rb \
  test/integration/finance_accounts_overview_test.rb \
  test/integration/finance_categories_test.rb \
  test/integration/finance_report_export_test.rb \
  test/integration/finance_workflow_test.rb \
  test/services/finance/receipt_reconciliation_test.rb
  PASS: 115 tests, 1,111 assertions, 0 failures, 0 errors, 0 skips.
```

The pre-existing full-suite evidence remains `803 tests, 30,891 assertions, 0 failures, 0 errors, 2 skips` in §11. The identity-api and billieforecast suites were not re-run because no files in those services changed. The root-level `npm run typecheck` command is **NOT TESTED/FAIL as a command choice** because the root package has no `typecheck` script; the client-level command above is the applicable check.

### 16.5 Verified behavior versus unverified assumptions

Verified: the catalog contract is replayed by Ruby and TypeScript; default navigation is Transactions / AI Assistant / Settings; available module visibility changes are persistent in the tested surface; disabling a module does not change financial fingerprints; hidden writes are refused; recurring posting continues; coming-soon modules are not interactive; Default and Manual mode remain independent of sidebar visibility; account ownership and data deletion invariants remain covered; local migration up/down/up is repeatable.

Unverified: Neon cloud migration against production-like data; native signed-in macOS shell after the migration; native restart persistence; native light/dark and English/Chinese behavior; native disabling of modules with local financial data; Windows/iOS/Android runtime behavior; any cross-device synchronization behavior. These are not inferred from automated component tests.

### 16.6 Remaining issues and blockers

1. **BLOCKED — Neon isolation/cost approval.** Product owner must authorize an isolated branch and confirm the acceptable Neon cost boundary before the migration can be tested against production-like data.
2. **BLOCKED — native authenticated QA environment.** Provide an isolated API/database target whose schema includes Phase 1a, or approve applying the migration to a safe dev branch. Do not point QA at the active production-backed port 3000.
3. **Known — local system Ruby mismatch.** Use the project Ruby 4.0.3 path or fix the developer shell’s Mise activation; no repository change was made for this environment issue.
4. **Phase 1b not implemented.** Web and app preferences remain separate by design until the architecture below is approved.

---

## 17. Phase 1b Proposed Architecture — Design Only

### 17.1 Authority and invariants

The server-side, account-scoped preference set is the authoritative synchronized state. The local client cache is an offline replica, never an authority over another device. An account means the authenticated BillieWeather user (`users.id`); the client must use an immutable account identifier, not an email address, as its storage namespace.

Invariants:

- Only authenticated users can read or mutate their own preference set.
- `settings` is a system entry, not a mutable module; coming-soon modules are never enabled by the API.
- A missing module row means the shared catalog default, so defaults remain backward compatible.
- A module preference changes visibility/access only; it never changes, deletes, or pauses financial data or authorized background jobs.
- Server revisions are monotonic and server-generated. Client clocks are advisory metadata only.
- A stale device cannot overwrite a newer same-module value without an explicit conflict decision.

### 17.2 Server-side data model

Keep the existing Phase 1a table as the base and add Phase 1b fields in a new additive migration (not executed in this task):

```text
finance_module_preferences
  id bigint primary key
  user_id bigint not null references users(id) on delete cascade
  module_key varchar(40) not null
  enabled boolean not null
  revision bigint not null              -- server revision of this module row
  changed_at timestamptz not null        -- server commit time
  updated_by_device_id uuid null         -- opaque registered device id
  created_at / updated_at timestamptz not null
  unique (user_id, module_key)
```

Add a request-id table for safe retries and response replay:

```text
finance_module_preference_mutations
  id bigint primary key
  user_id bigint not null references users(id) on delete cascade
  mutation_id uuid not null
  device_id uuid not null
  request_hash varchar(64) not null
  result jsonb not null
  created_at timestamptz not null
  unique (user_id, mutation_id)
```

Optional, if conflict UX needs durable cross-device notices rather than a local-only queue:

```text
finance_module_preference_conflicts
  id bigint primary key
  user_id bigint not null references users(id) on delete cascade
  module_key varchar(40) not null
  local_proposal jsonb not null
  server_value jsonb not null
  status varchar(20) not null              -- open / resolved / dismissed
  created_at / resolved_at timestamptz
```

The migration must be additive, use a Neon branch first, add indexes concurrently where supported by the deployment process, validate foreign keys, and avoid backfilling financial tables. Existing rows receive `updated_by_device_id = null` and retain their current value/revision semantics.

### 17.3 API contracts

All endpoints are under the existing authenticated client API and return an opaque account id only when needed by the client. The server derives `user_id` from the bearer token; a user-supplied account id is never trusted for authorization.

`GET /api/client/v1/module_preferences`

```json
{
  "format": 2,
  "account_id": "opaque-user-id",
  "server_revision": 41,
  "modules": {
    "transactions": {"enabled": true, "revision": 7, "changed_at": "2026-11-23T19:20:00Z", "updated_by_device_id": null},
    "reports": {"enabled": false, "revision": 3, "changed_at": "2026-11-23T19:21:00Z", "updated_by_device_id": "device-id"}
  },
  "defaults_version": 1
}
```

`PUT /api/client/v1/module_preferences`

```json
{
  "format": 2,
  "device_id": "opaque-device-id",
  "mutation_id": "uuid",
  "base_server_revision": 41,
  "changes": [
    {"module_key": "reports", "enabled": true, "expected_revision": 3}
  ]
}
```

Success returns `200` with the authoritative merged state, `applied`, `conflicts`, and the new `server_revision`. A repeated `mutation_id` with the same request hash returns the stored result without applying twice. A reused `mutation_id` with a different request hash returns `409`.

For partial conflicts the response may be `200` with per-module conflicts, or `409` when the product wants an atomic user decision. The recommended behavior is per-module partial success: unrelated modules continue to merge, while a same-module revision mismatch is returned as a conflict and is not overwritten.

### 17.4 Local cache and offline queue

Extend the current `ModulePreferences` envelope in `clients/universal/src/services/modulePreferences.ts:1-38` rather than replacing its storage abruptly:

```text
LocalModulePreferences {
  format: 2
  accountId: string
  deviceId: string
  serverRevision: number
  modules: map<module_key, {enabled, revision, changedAt, source}>
  pending: [{mutationId, baseServerRevision, changes, attempts, nextRetryAt}]
  conflicts: [{moduleKey, local, server, detectedAt}]
}
```

The active account namespace remains account-scoped (`billie.modules.v1:<immutable account id>`); a versioned `v2` key is safer than mutating old JSON in place. On startup, parse and normalize defensively. On an offline toggle, update the visible state immediately and append one idempotent mutation to `pending`. On reconnect, send mutations oldest-first with bounded exponential backoff and jitter. A successful response removes only the acknowledged mutation; unrelated pending mutations remain queued.

Logout parks or clears the active in-memory queue and prevents any request with the old token. Account switching reloads only the new account namespace, cancels old retries, and rejects any response whose account id does not match the current session. A failed cache read falls back to catalog defaults without deleting the cache.

### 17.5 Synchronization and conflict resolution

Use optimistic concurrency control at module granularity:

1. Initial sync fetches the server set and server revision.
2. For every local explicit choice, send `expected_revision` for that module.
3. If the expected revision matches, the server writes the value in a transaction, assigns a server revision/time, and returns it.
4. If it does not match, the server returns current and proposed values without overwriting the current value.
5. Changes to different modules do not conflict and are preserved independently.
6. The client marks a same-module conflict and asks the person to keep server, keep this device, or compare/select; the selected value is submitted as a new mutation with the current expected revision.

This deliberately does not rely exclusively on client timestamps and is not naive Last Write Wins. `changed_at` is server-controlled. A client timestamp may be retained as `client_changed_at` for migration explanation, but it cannot win a conflict. If the product later wants automatic resolution, the safe deterministic rule is server revision first, then server time, then device id only as a total-order tie breaker; it must never silently discard a pending local choice.

### 17.6 First-login and existing-user migration

The current web rows are the initial server truth because they already represent account-scoped choices. The current app cache is a separate local truth. Reconciliation must be explicit and per module:

| Server state | Local explicit state | First-sync action |
|---|---|---|
| absent/default | absent/default | use catalog default; write nothing |
| explicit | absent/default | keep server choice |
| absent/default | explicit | upload local choice as a migration mutation, unless the user declines |
| same explicit value | same explicit value | mark reconciled; no write |
| different explicit values | different explicit values | preserve both in a conflict record; do not silently overwrite either; ask the user to choose |

The first sync must complete before clearing or rewriting the v1 app cache. A migration marker stores `format`, account id, source values, and result so a retry cannot repeat or reverse a completed decision. Web clients that have no local cache simply consume the server set. App clients that have no cache consume the server set and then write a local replica.

### 17.7 Security and authorization

- Verify the existing bearer token before reading request bodies or touching preferences.
- Derive the account/user from the token; check tenant ownership on every query and mutation.
- Treat `device_id`, `mutation_id`, module ids, booleans, revisions, and payload size as untrusted input.
- Validate every module against the shared catalog and the requesting surface; reject `settings`, unknown ids, and `coming_soon` ids with `422`.
- Use row locks or a serializable transaction for compare-and-write; never increment revisions in application memory.
- Rate-limit sync requests, cap pending batch size, and do not log tokens, emails, financial data, or full preference payloads unnecessarily.
- Keep CORS limited to approved web/app origins and require HTTPS outside localhost development.
- Do not expose another device’s identifier as a user-facing identity; it is only an opaque conflict/debug value.

### 17.8 Representative Phase 1b tests

1. Unauthenticated GET/PUT is rejected; user A cannot read or update user B.
2. Unknown, system, and coming-soon modules are rejected and create no row.
3. GET returns catalog defaults for absent rows and preserves explicit rows.
4. A successful PUT increments server revision exactly once.
5. Retrying the same `mutation_id` returns the same result without a second write.
6. Reusing a mutation id with a different body is rejected.
7. Two devices update different modules concurrently; both changes survive.
8. Two devices update the same module; one receives a conflict and the newer server value is not silently overwritten.
9. A stale device cannot overwrite a newer server revision.
10. Offline toggles survive restart, retry after reconnect, and partial response failure.
11. A failed one-module update does not remove unrelated queued changes.
12. Clock skew and future client timestamps do not change server ordering.
13. First-login migration covers absent/same/different server and local choices without silent loss.
14. Logout and account switching never send the previous account’s queue under the new token.
15. Existing web rows and existing app v1 cache reconcile idempotently.
16. Disabling a module leaves transaction/account/receipt/recurring rows and background processing unchanged.
17. Migration rollback/forward recovery is tested on an isolated Neon branch and a disposable local database.

### 17.9 Rollback and failure recovery

Phase 1b should ship behind a server/client feature flag. The safe rollback order is: disable new sync writes, let existing clients continue using their local/server Phase 1a behavior, roll back client code, and only then consider a forward database cleanup. Do not drop preference or mutation history as an emergency action. Before every cloud migration create an isolated Neon branch or approved restore point; keep a schema-only rollback script and a data-preserving forward-fix script. A failed sync request must leave the pending mutation queued, and a failed migration must leave the app in its prior readable state.

### 17.10 Recommended implementation sequence

1. Product owner approves the isolated Neon branch/cost boundary and conflict UX.
2. Add contract/fixture tests for format 2 and migration reconciliation, with no production writes.
3. Add the additive server schema and read-only GET on an isolated branch.
4. Implement authenticated GET/PUT with per-module OCC, mutation idempotency, validation, and audit-safe logging.
5. Add the local v2 cache, device identity, offline queue, retry, account-switch guards, and conflict UI.
6. Run concurrent, offline, migration, security, and rollback tests on the branch.
7. Run authenticated native macOS QA against that isolated API/database, including restart, themes, English/Chinese, and data-preservation checks.
8. Product owner approves dev migration; apply only to the approved dev target and verify.
9. Product owner separately approves production rollout, backup/restore point, and monitoring.

### 17.11 Exact next steps requiring product-owner approval

- Approve or reject creation of a short-lived Neon validation branch and its compute/storage cost boundary.
- Provide/approve an isolated authenticated API target for native macOS QA, separate from port 3000’s production-backed service.
- Choose the first-sync conflict UX: mandatory per-module choice (recommended) or a documented deterministic server-preferred policy.
- Approve the format-2 API and additive schema above, including whether durable conflict rows are needed.
- Approve the Phase 1b implementation sequence; no synchronization API or Phase 1b migration should be started before that approval.
- After validation, separately approve applying the existing Phase 1a migration to Neon development. Production migration, deployment, commit, push, merge, and Phase 2 remain out of scope.

---

## 18. Phase 1a 最终验收（2026-11-23）

**结论：隔离环境下 Phase 1a 通过。** 14 项原生 macOS 验收均有实际操作证据。建议 Phase 1b 可进入独立评审与排期。本次执行到 Phase 1a 为止，提交、推送、合并和部署均为零。

### 18.1 数据库连接审计

| 范围 | 本轮核实结果 |
|---|---|
| Rails Web 开发 | `config/database.yml` 定义本地 PostgreSQL 默认库。开发组的 Dotenv 从 `.env.local` 注入 `DATABASE_URL`，覆盖默认配置。现有 :3000 的进程工作目录指向当前仓库，开发日志有 `PendingMigrationError`。配置文件的池化和直连端点都与 Neon CLI 只读元数据中 `production` 的计算端点匹配。 |
| Python identity-api | 现有 :8100 的进程工作目录为服务目录。`identity_api/config.py` 读取该目录的 `.env`，其中 `DATABASE_URL` 与 Rails 开发配置指向同一个 Neon `production` 端点。验收服务通过独立环境连接本地数据库。 |
| Universal Tauri | 账本使用按应用标识隔离的本机 SQLite。原生构建通过 `VITE_BILLIE_API_URL` 和 `VITE_BILLIE_IDENTITY_URL` 访问 HTTP 服务。开发脚本默认 :3000 和 :8100，所以默认开发构建会经这两项服务到达生产分支。QA 构建将服务地址及 CSP 限定到本轮的专用回环端口。 |
| 脚本和环境变量 | `bin/dev` 用 Overmind 或 Foreman 启动 `Procfile.dev`。现有 `.overmind.env` 只选择 Procfile。当前命令行环境没有继承数据库 URL。若设置 `DATABASE_URL_UNPOOLED`，`lib/tasks/neon.rake` 会将迁移任务切换到该连接。Docker 开发入口设置本地数据库角色并挂载仓库，仍需核查进程中生效的 URL。验收启动器以清空继承环境后的显式本地 URL 启动 Rails，临时副本排除了项目的环境文件。 |
| Render | 根 `render.yaml` 声明生产 Rails 的 `DATABASE_URL` 为手动注入值，并配置构建阶段执行迁移和 seed。identity-api 有独立蓝图，声明使用 Rails 的同一个 Neon 数据库，启动时迁移 `identity` schema。实际 Render 控制台变量无法从蓝图确认。 |
| Neon 分支 | 只读元数据确认默认分支为 `production`。`migrate-test-nickname` 的来源为 `parent-data`，父分支是生产，未用于验收。由于无法确认新分支的账户级成本边界，本轮云分支创建次数为 0。若需要云端验证，应另行批准专用开发分支及费用范围。 |

本轮 Neon 操作为分支和计算端点元数据读取。生产数据库连接、迁移和写入次数均为 0。报告保留了 §16 的早期测试历史。现有 :3000 和 :8100 在验收前后分别保持 PID 17633 和 17597。已安装的应用标识为 `com.billieweather.client`，本轮只操作专用 QA 应用。

### 18.2 隔离环境、迁移回滚和完整性

- 使用 PostgreSQL 18.6 从空目录初始化集群，目录位于 `/private/tmp/billie-phase1a.BN3BWxD1/pg`，只接收私有 Unix socket，关闭 TCP 监听。验收库为 `billie_phase1a_acceptance`，回归库为 `billie_phase1a_regression`。迁移前由 PostgreSQL 和 Active Record 分别核对数据库名、数据目录和 socket 连接。初始验收库的 `public` 表数量为 0。
- 从 Git `e4380af` 的 `db/schema.rb` 装载迁移前结构，确认 `20261123000100` 为唯一待执行版本。插入合成用户、银行账户、账单和交易。应用 → 回滚 → 重新应用通过。回滚后表和迁移登记都消失，再次应用后两者恢复，额外运行一次迁移无待执行版本。
- 比较 `users` 及既有财务表的行数和行内容指纹。三次检查的 **27 张表**均与迁移前一致。直接验证主键、`(user_id, module_key)` 唯一性、非法模块键和零修订号被拒绝、修订号默认 1、孤立用户引用被拒绝，以及删除用户时偏好级联删除。
- Python 服务在同一验收库通过 Rails schema 兼容性检查。第一次应用 `0001_identity_schema` 和 `0002_email_verifications`，第二次执行无待迁移项。独立 Rails `:33123/up` 和 identity-api `:38123/health` 都返回 HTTP 200。使用私有本地邮件 outbox 验证一次性 `example.invalid` 账号，验收库最终的 3 个用户均为合成账号。
- 验收结束后关闭专用应用、Rails、identity-api 和 PostgreSQL 集群，清除临时登录输入文件、本地验证邮件及 Downloads 中的临时 CSV。保留本机的隔离集群、测试日志和合成账本作为复核材料。

### 18.3 原生 macOS 验收与证据

使用 Apple Silicon 上 macOS 27.2.1 的打包版 Tauri 应用 `BillieWeather Phase 1a QA.app`。独立 Bundle ID 为 `com.billieweather.phase1a.qa.bn3bwx`，使用独立 URL scheme、Keychain 命名空间、WebKit 数据和 SQLite 路径。原生可访问性树显示 `standard window BillieWeather Phase 1a QA` 和 `HTML content … URL: tauri://localhost`。以下记录来自实际原生界面的可访问性观察和截图核对，截图在验收会话中显示。

| # | 验收项目 | 原生观察与结果 |
|---|---|---|
| 1 | 登录与登出 | **通过。** 一次性账号登录后到达首次数据库命名和欢迎界面。退出回到 `Sign in to BillieWeather`，重启仍在登录页，QA Keychain 会话条目已清除。 |
| 2 | 默认导航 | **通过。** 新账号进入后侧边栏依次为 `Transactions`、`AI Assistant`、`Settings`。 |
| 3 | Transactions Overview | **通过。** 默认进入 Overview，录入、同步和导入后显示收入 $45.00、支出 $18.76、净现金流 +$26.24。 |
| 4 | All Transactions | **通过。** 原生列表显示 `4 of 4 transactions`，含 1 笔手工、1 笔同步和 2 笔 CSV 导入交易。 |
| 5 | Add & Sync | **通过。** 打开导入和收据捕获界面，用原生文件选择器从标准 Downloads 路径选择合成 CSV，预览然后导入 2 笔，跳过和失败均为 0。在数据管理中预览并确认从隔离 Rails 复制 1 个账单、1 笔交易，账单从 `不在本机` 变为 `已在本机`。 |
| 6 | AI Assistant | **通过。** 原生页面显示本机命令栏、AI 分类入口及网页洞察入口。运行 `show transactions`，返回 `1 matching transaction(s).` 并跳转交易列表。 |
| 7 | Settings → Feature Library | **通过。** 通过设置页入口打开 12 张模块卡片，显示全部、已开启、可用、即将推出筛选。 |
| 8 | 启用与停用模块 | **通过。** Accounts & Assets 和 Budgets 启用时即时加入侧栏，停用 Accounts & Assets 时移除，重新启用后可打开账户。 |
| 9 | Coming Soon | **通过。** 筛选只出现 Ledgers、Goals & Planning、Household、Cash Flow Forecast、Multi-Currency，五个开关均为 disabled/off。Add & Sync 的银行连接卡片显示 Coming soon。 |
| 10 | Default / Manual | **通过。** 默认模式下隐藏 `New entry`。手动模式用该按钮保存合成支出 $12.34，切回默认后可看到同一笔交易，模块侧栏选择继续生效。 |
| 11 | 重启后保留偏好 | **通过。** 完整退出并重启后账户保持已登录，Budgets 仍为 on，Accounts & Assets 仍为 off。简体中文和深色也继续生效。 |
| 12 | 停用模块后保留数据 | **通过。** 停用前、停用后和重启后的 SQLite **19 张表**行内容指纹一致。`integrity_check` 为 `ok`，`foreign_key_check` 无异常。重新打开账户后显示期初 $100.00 扣除 $12.34 后的余额 $87.66。 |
| 13 | 英文和简体中文 | **通过。** 在 Settings 中双向切换。中文界面显示 `交易`、`AI 助手`、`设置与隐私`、`功能库`，切回英文后为对应英文页面。 |
| 14 | 浅色和深色 | **通过。** 分别选中 Light 和 Dark 并检查实际窗口截图。英文浅色截图为 `All Transactions`，简体中文深色截图为 `功能库`，显示停用的账户模块和启用的预算模块。 |

文件选择器在直接访问 QA 私有临时目录时曾保持 Open 禁用，期间辅助功能会话超时。从标准 Downloads 路径选择内容相同的 CSV 后，原生导入完整通过。具体是路径权限还是文件选择器状态导致初次失败仍未确认。第三方 AI 服务实时响应、实际银行接入及跨设备偏好同步未纳入本轮原生验收。

### 18.4 最终回归结果

| 套件 | 本轮命令 | 结果 |
|---|---|---|
| Rails 非系统测试全量 | Ruby 4.0.3 下于隔离回归库运行 `bin/rails test` | **808 项，30,899 断言，0 失败，0 错误，2 跳过**。跳过项为既有脚手架用例。 |
| Universal + 共享包 | 在 `clients/universal` 运行 `npm test -- --reporter=dot` | **897 通过，12 跳过，0 失败**。67 个文件通过，1 个跳过。 |
| TypeScript | 在 `clients/universal` 运行 `npm run typecheck` | **通过，0 错误**。 |
| 共享财务域专项复跑 | 用 Vitest 路径过滤 `packages/finance-core`、`packages/reporting`、`packages/shared-types` 和 `packages/billie-commands` | **16 个文件，364 项通过，0 失败，0 跳过**。计数包含于上方 Vitest 全量结果。 |

Rails 首次全量运行时，隔离启动器的 PATH 缺少 Yarn，OpenAPI lint 用例失败。为回归进程补齐项目 Node/Yarn 路径后单测通过，随后全量重跑为全绿。回归复用快照中的 Rails 前端构建资产。原生 QA 构建重新运行了 TypeScript 和 Vite 构建。

### 18.5 剩余事项与就绪判断

Phase 1a 的本地迁移、原生验收和回归均通过。现有开发服务仍配置为生产分支，云端迁移行为及 Render 实际环境值仍待使用经批准的隔离目标核验。这是部署就绪的待办。建议接受 Phase 1a 的本地验收结果，并以单独授权开启 Phase 1b。
