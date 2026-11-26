# rc3 native checklist (macOS Apple Silicon), required before GO

These checks must pass on the rc3 build that is actually shipped. Each run records:
- the git SHA it was built from,
- the build number,
- the SHA-256 of `Contents/MacOS/billieweather`.

The Phase 6.3 runs a1–e1 ran on rc1, not rc2 (audit C-01), so they do not count toward rc3.

## Harness rules (apply to every check)

- **Provenance.** Before the first step, record `git rev-parse HEAD`, the build number, the executable hash and `codesign -dv` output, and put them in the results file. A run whose hash differs from the shipped rc3 does not count.
- **Seed module preferences explicitly.** Optional modules (Accounts, Categories & Tags, Budgets, Reports, Recurring) are off by default. Their choices live in WebView localStorage (`billie.modules.v1:<ownerKey>`, or `billie.modules.v2:<accountId>` when synced), not in SQLite. Seed them, or turn them on through Settings › Feature Library inside the run. Never rely on state left by an earlier script.
- **Report a module that is off separately from one that is missing.** When a sidebar item is absent, check the Feature Library switch (`role=switch`, `aria-checked`) and report "MODULE OFF: <id>", not "NOT FOUND". This is audit B-02, the false Categories failure.
- **Match on stable label prefixes.** Use prefixes such as "Categories" matching "Categories & Tags", "Undo:" and "Redo:". Labels were renamed in Phase 1a.
- **Wait on screen state, not fixed sleeps.** Wait for a heading, an `aria-current` change, a status or alert text, or a DB row count. Use a timeout and record a screenshot when it expires. The e1 failure came from a fixed 4 s sleep that read only the window title.
- **Use the QA variant only.** Use the QA bundle identifier and its own data folder and Keychain entry, through `node scripts/qa.mjs build | preflight | launch`. Never touch `com.billieweather.client` data or `/Applications/BillieWeather.app`.
- **Synthetic data only.** For every check that edits data, compare `SELECT *` fingerprints of the affected tables before and after.

## Checks

| # | Check | Expected result | Proves |
|---|---|---|---|
| 1 | Fresh install: register (nickname required), name the database, import a CSV, quit, reopen | Welcome shown once. Import preview, then confirm, then rows on screen. After reopen, identical rows and the same database name. No migration error. | A-01 load path: migrator on every load plus `checkSchemaVersion` (`platform.ts`) on the real plugin. B-05 nickname on sign-up. |
| 2 | Upgrade over a 0.1.0 install (schema 9) | Opens without a system prompt. Automatic copy made and byte-identical. Every row of every table identical. Dark theme and module choices kept. | A-01 (migrations stay registered), upgrade integrity. |
| 3 | Failed migration, then retry: block the migration (e.g. the locked file used in e1/e2), open, then remove the cause and open again | First open: the "could not be opened" screen with the matching reason, schema 9 and rows untouched, and the app quits cleanly. Second open: upgrades, with rows identical. | A-01 (a retry migrates again instead of opening unmigrated). This closes the e1/e2 failures (C-03). |
| 4 | Rollback: open the schema-10 book with 0.1.0 | 0.1.0 refuses with the "newer version" message on every attempt, and rows are unchanged. Reopening with rc3 works. Restoring the automatic copy for 0.1.0 works. | C-02 downgrade fence, A-01 fence on every load. |
| 5 | Add a second database, switch back and forth three times, run a local-to-local sync on the Data page | Each switch shows the right book. The sync previews and then adds only missing statements. No "could not be opened" error. | A-01/A-14: every load re-runs the migrator, registered slot names only; no regression for book N. |
| 6 | Restore an automatic copy into a new slot (Data page) | The copy is listed as "<name> (<date>)", is migrated to the current schema, and has the original's rows. The original book is untouched. | A-01 (a restored older copy is migrated on open), restore path (`useFinance.tsx` openSnapshot). |
| 7 | Sign out, then sign in as a second synthetic account, then back | Sign-out removes the Keychain item. Account 2 never sees or lists account 1's book. Signing back in reopens account 1's book. | C-10 / `session.rs` changes, ownership isolation (A-03). |
| 8 | Undo/redo: edit text, note, tag and amount; Undo/Redo buttons; ⌘Z / ⇧⌘Z; ⌘Z inside a text field | The book is restored exactly after Undo and repeated after Redo. ⌘Z in a field does not touch the book. | Editing history on the shipped build (c2 ran on rc1 only). |
| 9 | Categories & Tags: turn it on in the Feature Library, open it, check the custom category and remembered rules | "Categories & Tags" appears in the sidebar, the page shows the seeded custom category in the tree, and rule counts match the DB. | B-02 (false "NOT FOUND: Categories"). Shows the feature works when the module is on. |
| 10 | Cloud download that overlaps a local import: import a CSV locally, upload the same statement on the website as another file or export, then sync | Rows already stored are not added twice. The skipped count is visible (or, if B-S1 is not fixed, it is recorded as a known gap). Every other row arrives. A failed download leaves the book unchanged. | A-04 (duplicate skip), A-05 (one transaction, including the account and categories). |

Also record, but do not gate on: dark mode follows the system and the explicit choice; an AI-categorize failure shows the error message (S6 console logging was rejected by the Chief: `privacy.test.ts` forbids client logging); a Transactions save failure shows an alert (B-06).
