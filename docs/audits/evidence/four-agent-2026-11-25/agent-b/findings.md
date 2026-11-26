# Agent B — Product, UX & Cross-Platform Clients (Phase 1)

Filed by Chief from Agent B's hand-back (subagent could not write this file). Raw evidence in this folder: `rails-integration.log`, `vitest-tail.log`, `tsc.log`, `web-walkthrough.log`, `walk.mjs`, `walk2.mjs`, `web-addsync.png`.
Chief spot-verified 2026-11-25: B-01 (repo-root `postcss.config.js:1-4` runs `execSync('bundle exec bin/theme …')`; `clients/universal/vite.config.ts` sets no `css.postcss`, no local postcss config), B-06 (`clients/universal/src/pages/Transactions.tsx:128` single `role="status"` line).

Incident: B's temp cluster dir `pgB.oFYR` was deleted by another agent's cleanup *after* B's DB runs finished — no result affected.

## (a) Platform capability matrix
"Web" = the Rails site. The React client in a plain browser is an in-memory preview only (`clients/universal/src/services/platform.ts:31-40`, `persistent: false`).
Legend: IT implemented+tested · IU implemented, untested on platform · ST stub/Coming soon · NB code exists, never built/compiled.

Builds: Web — Rails, 439 integration tests + headless walkthrough. macOS arm64 — RC2 ad-hoc DMG (`ClaudeGenerated/phase6.3-rc2/personal-release/BillieWeather-0.9.0-beta.1.dmg.json`), not notarized, Gatekeeper rejects. macOS Intel — NB (no x86_64 artifact; CI macos-latest is arm64). Windows — NB, CI build fails (B-01). iOS/Android — NB (no `src-tauri/gen/`, mobile CI manual-dispatch only, never run).

| Feature | Web | macOS arm64 | Intel / Win / iOS / Android |
|---|---|---|---|
| Auth | IT | IT (Keychain per variant `src-tauri/src/session.rs:26`) | NB |
| Onboarding + nickname | IT for new sign-ups; legacy = dismissible prompt (B-05) | IT (jsdom) | NB |
| Transactions | IT | IT (vitest; native a1/c1) | NB |
| AI Assistant | IT (server-side) | Partial: commands + AI categorize; insights open website (`Assistant.tsx:1-4`) | NB |
| Settings + Feature Library | IT | IT | NB |
| CSV/TSV/XLSX/OFX | CSV IT; XLSX/OFX absent | IT | NB |
| PDF import | IT (text PDFs) | IT | NB |
| Receipt OCR | ST by default (`app/services/finance/local_ocr.rb:3-5`, off unless `BILLIE_LOCAL_OCR_COMMAND`) | IT (Apple Vision `ocr.rs:24` + Tesseract fallback; real-engine suites skipped in this run) | NB |
| Manual entry | IT | IT | NB |
| Review/confirm | IT | IT | NB |
| Persistence across restart | IT (Postgres) | IT (native upgrade check, 1334 rows / 17 tables identical — prior evidence, not re-run) | NB |
| Undo/redo | Partial (batch + command undo) | IT (vitest; native c1 on rc1) | NB |
| Dark mode | IT (headless) | IT (jsdom; native a1) | NB |
| i18n (6 locales) | IT (key parity script) | IT (`i18n.test.ts`) | NB |
| Connect Financial Accounts | ST | ST | ST |

## (b) Defect register
| ID | Sev | Class | Location | Summary / fix |
|---|---|---|---|---|
| B-01 | P1 | REPRODUCED (CI log) + CONFIRMED | clients/universal/vite.config.ts; postcss.config.js:3 | Vite walks to repo-root PostCSS config which runs `bundle exec bin/theme` → Windows CI build fails; 31/31 `universal-client.yml` runs failed (latest 45253715553). 70 local commits unpushed ⇒ CI never built 0.9.0-beta.1. Fix: inline `css.postcss.plugins: []` + guard test in `test/package.test.ts`. |
| B-02 | P1 | CONFIRMED + native log | src/services/modulePreferences.ts:12; test/helpers.ts:91; src/hooks/useModules.tsx:34-37; app/controllers/finance/base_controller.rb:37-45 | Root cause of Categories false failure. Only transactions + ai_assistant default on; app prefs in WebView localStorage not SQLite; QA seed writes ledger only; b1 pressed "Categories" → NOT FOUND (`native-all.txt:7`). Masks: generic `openInShell` error; `useModules` no-provider fallback = all on; Rails returns 200 for disabled page. At-risk: Rails `finance_dashboard_period_test.rb:43`, `privacy_data_deletion_test.rb:75`, `finance_smart_command_test.rb:177`; native a1/b1/part2/3/7. Fix: `ModuleDisabledInTest`, `assert_module_page`, seed writes prefs, fallback to catalog defaults. |
| B-03 | P2 | REPRODUCED (headless) | dashboard/index.html.erb:27,104,105; _spending_mix.html.erb:24; _analytics.html.erb:38; settings/show.html.erb:158,376,399; Dashboard.tsx:139,142 | Default users see links to turned-off pages (Export report, balances, export-before-delete). One-click "Turn on" exists → friction. Fix: hide/relocate; default-user link-crawl test. |
| B-04 | P2 | CONFIRMED | module_catalog.rb:61; billie-commands/src/actions.ts:170 | typed commands ignore module state. Document or filter. |
| B-05 | P2 | CONFIRMED (intent = HYPOTHESIS) | NicknamePrompt.tsx; Dashboard.tsx:86 | nickname mandatory at sign-up only; legacy accounts dismissible prompt; hidden if Transactions off. Product decision. |
| B-06 | P2 | CONFIRMED | Transactions.tsx:128; styles.css:154 | save errors shown in green polite status. Fix: `role="alert"` error line. |
| B-07 | P2 | CONFIRMED | AiCategorizePanel.tsx:26-31,52 | unexpected errors rethrown → unhandled rejection, no message. Fix: generic error branch. |
| B-08 | P2 | CONFIRMED | App.tsx initialPage | turning core module off leaves turned-off start page. |
| B-09 | P1 (release claims) | CONFIRMED | clients/universal/README.md; capabilities/default.json | README "Windows configured in CI" misleading. |
| B-10 | P2 | CONFIRMED | – | web undo ≠ app undo (record, don't expect parity). |
| B-11 | P2 | UNTESTED | useModules.tsx:73-157 | v2 module sync path never runs in UI tests (no ownerId). |
| B-12 | P2 | HYPOTHESIS | AddSync.tsx:30-34; add_sync/show.html.erb:11-15 | "Connect Financial Accounts" Coming-soon card still ships — needs canonical removed-features list. |

Checked fine: i18n parity (app + Rails); focus management; Feature Library switches `role="switch"`; onboarding covered; no fake bank-connect flow; AI consent gate. No removed financial-services feature reachable.

## (c) Commands/results (DATABASE_URL/NEON_*/RENDER_* unset; .env.local never sourced)
`npx vitest run` 86 files (85 pass, 1 skip), 1178 tests (1165 pass, 13 skip, 0 fail); `npx tsc --noEmit` exit 0; temp PG :55432 + `bin/rails test test/integration test/models/finance/module_catalog_test.rb` 439 tests / 28801 assertions / 0 F/E/S; synthetic `:onboarded_user` + `rails server -p 3212` + headless walkthrough (B-03 reproduced, dark mode OK); `vite build` in .git-less mirror with failing fake `bundle` OK (consistent with B-01); `gh run list/view` read-only 31/31 failures; Rails locale parity: no missing keys. Not run: system tests, cargo, native GUI, mobile/Windows builds.

## (d) Data assumptions (for Agent A cross-review X-1)
1. Module prefs are view-only, never gate writes; typed commands bypass them.
2. App module prefs in WebView localStorage (`billie.modules.v1:<ownerKey>`, `billie.modules.v2:<accountId>`), not SQLite; not carried by backup/restore/DB switch; server-side "Delete my financial data" keeps them.
3. `ownerKey` (`ownerKeyFor`) stable across upgrades; derivation change silently resets prefs and nickname snooze.
4. macOS restart persistence taken from Phase 6.3 evidence, not re-run.
5. Browser `npm run dev` is a demo; Rails site = Web.
6. App receipt creates one manual entry, no receipt row (README; not schema-checked).
7. Legacy whitespace-only/invisible-char nickname may pass `trim()` (hypothesis).
8. UI test accounts lack ownerId ⇒ module sync off in UI tests.
