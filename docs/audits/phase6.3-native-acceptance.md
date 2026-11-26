# Phase 6.3 native acceptance: upgrade, failed migration, undo, rollback

2026-11-25, on this MacBook, against QA bundles only (`com.billieweather.client.qa.p63`, own data folder
and Keychain item, isolated backend on 127.0.0.1). The installed `/Applications/BillieWeather.app` and its
data were not opened.

| Build | Executable SHA-256 (prefix) |
| --- | --- |
| candidate rc2 (0.9.0-beta.1, schema 10) | `186f548336023458` |
| previous release 0.1.0 (schema 9), rebuilt as QA bundle | `bb59077d4e78ff1a` |

Test book: synthetic, 1334 rows in 17 tables at schema 9 (`v9-book.db`), with a remembered merchant rule
set, one own category ("ZXQ Hobby"), budgets and a synthetic signed-in account.

## Result: all 8 steps pass

| # | Step | Result |
| --- | --- | --- |
| 1 | Migration 10 forced to fail (a conflicting trigger in the book) | PASS: "The local database could not be opened. Your data has not been changed." with *Try again*; schema stays 9, no history objects, all 1334 rows identical |
| 2 | Cause removed, same build relaunched | PASS: upgraded to 10, integrity `ok`, all rows identical, still signed in |
| 3 | Categories and remembered rules after the upgrade | PASS: own category shown; 2 rules and 1 own category unchanged |
| 4 | Undo bar | PASS: an edit, then *Undo: edit "QA SYNTHETIC CAFE"*, restores the row |
| 5 | Edit in 0.9, sign out, quit | PASS |
| 6 | 0.1.0 opens the schema 10 book | PASS: refuses with "It was last opened by a newer version of BillieWeather… Your data is unchanged."; rows and schema 10 unchanged |
| 7 | Documented rollback: newest `billieweather.db.pre-v10-*.bak` into place, open in 0.1.0 | PASS: schema 9, all 1334 rows identical to the original book; the 0.9 edit is (as documented) not in it |
| 8 | Forward again in rc2 | PASS: schema 10, integrity `ok`, all rows identical |

Steps 1–5 passed in one run (20:30). Steps 6–8 passed at 21:37 in a run started from a copy of the QA data
folder taken immediately after step 5 passed (`ckpt-e2-after-edit`), because the desktop was repeatedly
in use or locked; the driver pauses rather than act on someone else's input. Every attempt, including the
paused ones, is in [native-e2.txt](evidence/2026-11-25-phase6.3/native-e2.txt) and
[e2-runner-log.txt](evidence/2026-11-25-phase6.3/e2-runner-log.txt).

Screenshots: [failed migration](evidence/2026-11-25-phase6.3/shots/e2-migration-failed.png),
[categories](evidence/2026-11-25-phase6.3/shots/e2-categories.png),
[undo bar](evidence/2026-11-25-phase6.3/shots/e2-undo-bar.png),
[0.1.0 refuses](evidence/2026-11-25-phase6.3/shots/e2-old-refuses.png).
Script: [e2.py.txt](evidence/2026-11-25-phase6.3/e2.py.txt) (uses `accept.py.txt`).

## Observations

1. **The automatic copy is taken once per schema, at the first upgrade attempt.** When that attempt
   fails, the copy is the untouched pre-upgrade book (correct: a failed migration changes nothing), and the
   later successful attempt makes no second copy. Rolling back therefore restores exactly what was there
   before the first attempt. In this test that included the injected trigger, so step 8 removes it again,
   as step 2 did, before going forward (recorded in the result). No app change needed.
2. **0.1.0 may refuse before or after its sign-in screen**, depending on whether a session is still in
   its Keychain item. Both show the same message and change nothing; the script accepts either.
3. During two attempts macOS showed a **SecurityAgent** (Keychain access) prompt, most likely the
   0.1.0 QA build asking for the QA Keychain item after its signature changed between rebuilds. It
   concerns QA bundles only; the shipped app's item is separate. Those attempts were not counted.

## Test-script fixes during this run (not app changes)

- Categories: enable the module in Feature Library first, then open it.
- Failed-migration screen: poll the accessibility tree for up to 25 s instead of a fixed 4 s.
- Switch the book to Manual mode before *Add & Sync* (the upgraded book opens in Default mode).
- Quit any running QA instance before every launch (a leftover instance triggered the single-instance
  alert and blocked later attempts).
- Resume from the post-step-5 copy; order-independent refusal check; step 8 as in observation 1.

## Remaining before replacing the installed 0.1.0

- The "Stable servers" decision (docs/dual-mac/ARCHITECTURE.md): the candidate signs in through
  `localhost:3000/8100` like 0.1.0.
- Install with `ops/install-stable.sh` (branch `infra/dual-mac`), which backs up the app and data folder
  first; not done.
