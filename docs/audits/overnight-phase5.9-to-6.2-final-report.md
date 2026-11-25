# Overnight sprint: Phase 5.9 to 6.2

2026-11-25, 01:25 to about 02:40 CST, and 03:01 to 03:10, branch `autonomous-development`, macOS 27.2.1, Apple Silicon. Nothing was pushed, merged or deployed. Neon and Render were not contacted. No cost. Evidence: [evidence/2026-11-25-overnight](evidence/2026-11-25-overnight/).

## 1. Summary

- **Please do first**: a macOS authentication prompt has been on the screen since about 02:23. It appeared when the second QA build was launched over the first build's sign-in. I did not read, answer or close it. The likely cause is keychain access by a differently signed ad hoc build. It belongs to a QA app that is already stopped; **Deny** or **Cancel** is safe for BillieWeather.
- That prompt, still there at 03:05, stopped native testing of the final build. **Native acceptance is complete for neither build**: most workflows PASS on build c1; no workflow was run on any later build, and the final one (c4) was never started.
- Three defects were found natively and fixed, and more by other means (section 7). The fixes have been seen in automated tests and headless browsers, **not on the final build's screen**.
- Both open security findings have a mitigation, rehearsed in production mode on isolated databases (section 10).
- All suites pass, except two old browser tests (section 11).

| Scope | Decision |
| --- | --- |
| Personal local macOS use of the final build | **NO-GO** until section 19, step 2 |
| Isolated QA use | **CONDITIONAL GO** |
| External macOS distribution | **NO-GO**: no Developer ID, not notarized |
| Production backend | **NO-GO**: engineering and rehearsals done; Neon, Render and approvals outstanding |
| Intel, Windows, iOS, Android | **NO-GO**: not built |

**Phase 6.2 is not complete.** Mandatory platforms are unverified.

## 2–5. Phase status

| Phase | Status | Open |
| --- | --- | --- |
| 5.9 native acceptance | **BLOCKED** (c1 mostly PASS, final build not accepted) | the prompt; section 6 |
| 6.0 consolidation, architecture | Engineering **PASS** | merge needs approval |
| 6.1 infrastructure, security, release engineering | Local part **PASS**; production **BLOCKED** | Neon, Render, Developer ID, notarization |
| 6.2 cross-platform | Web **CONDITIONAL GO**; other platforms **BLOCKED** | toolchains, devices, signing |

6.0: all 115 dirty files in `billieweather` were hash-compared (read-only): **all identical to `d3061e4`**. `main` = `origin/main` = `e4380af`, no own commits; fast-forward rehearsed in a clone, same tree. That checkout was not changed. Two Cargo cache folders of old test runs were removed (8 GB).

## 6. Native GUI matrix

c1 = commit `f258e7a`, executable `e1aa3a3d…`, tested 01:57–02:10. Final = c4 (section 14); c2 and c3 were launched without any workflow being run. c1 results are **not** carried over to the final build.

| Workflow | c1 | Final |
| --- | --- | --- |
| Registration; empty form; short, wrong and right email code | PASS | NOT TESTED |
| Sign in, wrong password, sign out (confirmed on the server) | PASS | NOT TESTED |
| Offline sign-out, then automatic retry when the server returned | PASS (revoked within 50 s of the server answering) | NOT TESTED |
| Sign out other devices: Cancel keeps, confirm ends the other, own stays | PASS | NOT TESTED |
| Database creation, selection, backup, restore (verified copy) | PASS | NOT TESTED |
| Restart: session, module choice and data kept | PASS | NOT TESTED |
| CSV: cancel, import, repeat refused | PASS | NOT TESTED |
| Scanned PDF (Apple Vision): review, decision, import | PASS (defect G1) | NOT TESTED |
| Receipt: read, save, duplicate offered, damaged file refused | PASS | NOT TESTED |
| Editing; category change with remembered rule | PASS | NOT TESTED |
| Protection of a category the person chose | NOT TESTED natively: Reclassify was pressed on the other statement. Automated PASS | NOT TESTED |
| Undo of an organize run | PASS | NOT TESTED |
| Undo of a single manual change; redo | not implemented in the product (decision, section 18) | – |
| Trash, restore; delete for good: Escape, Cancel, confirm | PASS | NOT TESTED |
| Feature Library, Settings, dark theme, six languages | PASS | NOT TESTED |
| Second copy of the app refused, opens no database | PASS (message not seen) | NOT TESTED |
| Another account's automatic copy | No data shown (0 rows), defect G3 | NOT TESTED |
| Keyboard: Escape, focus on Cancel, heading focus | PASS | NOT TESTED |
| Keyboard: Tab order, skip link, menus | NOT TESTED | NOT TESTED |
| OCR cancel, Tesseract fallback, crash during import | NOT TESTED natively; automated PASS | NOT TESTED |
| Install from DMG, upgrade over older data | NOT TESTED | BLOCKED (prompt) |

## 7. Defects found and fixed

| # | Found | Fix | Seen working |
| --- | --- | --- | --- |
| G1 | Date-order menu ran past the window (native) | Field grid | headless only |
| G3 | Another account's automatic copy: generic message, stayed listed, left a file owned by them (native; no data exposed) | Own message in six languages, hidden afterwards, slot free again | automated |
| – | Spanish Settings wider than a 320 px phone | Buttons wrap | headless |
| – | Web receipts page: duplicate id; 118 px too wide on a phone | Fixed, new page-structure test | headless |
| – | iOS: no camera text, which ends the app when scanning | `Info.ios.plist` | **not built** |
| – | Android: ledger would go to Google cloud backup | Excluded in the manifest | **not built** |
| – | Windows: start-up alert invisible | `MessageBoxW` | type-checked only |
| – | Two copies of the app could share databases | Lock, message in six languages | c1 |
| – | Sign-out retried only at start or network return | Every minute while open | c1 |
| – | Identity tests fell back to a non-isolated database | Must be named explicitly | yes |
| – | 44 of 44 browser tests failed on current Chrome; others were outdated or random | Repaired, 42 pass | yes |
| – | Identity log did not redact tracebacks | Redacted | automated |

Fixed at 03:03 (`79ab6c9`): "1 entries deleted for good"; the import page listed fewer formats than it reads. Seen, not fixed: the API platform application has no name in the team list; a remembered rule can be as broad as "qa synthetic".

## 8–9. Architecture and databases

- Decision: [keep Rails, extend FastAPI by boundary](../architecture/adr-2026-11-25-backend-direction.md). Step A (contract tests) is recommended; no rewrite.
- No schema change. Reviewed: composite owner foreign keys on the financial tables. PostgreSQL: 81 foreign keys, 78 checks, migrations up to `20261125000100`. SQLite schema 9; the three QA databases pass integrity and foreign-key checks.
- One version source, build number = commit count.
- `pg_dump` and restore: 64 tables identical. Owner and runtime roles rehearsed: the owner role and a wrong target are refused; without the `user_sessions` grant it fails closed.

## 10. Security

1. **Rollback**: the signing key moved to `BILLIE_SECRET_KEY_BASE`. Rehearsed: without the fence a rollback accepts signed-out tokens (200). With it the old release refuses to boot or answers 401. `rollback/session-safe` (local branch) is the old release with server-side sign-ins; its session tests pass (25). Its full suite has 785 tests and 5 failures, the same five as unmodified `main`. The fence works only after **you delete `SECRET_KEY_BASE`** in Render ([runbook](render-neon-release-runbook.md)).
2. **Offline sign-out**: fundamental limit. A copied token works until the server hears of it. Now also: end after 14 unused days, retry every minute, start-up check of production settings. Limit: 30 days.
3. Minimal Content-Security-Policy on the website. Production-mode smoke test with the real start command: PASS; 0 emails, passwords or tokens in the log. Script and style directives are still open.

## 11. Tests (final source unless noted)

| Suite | Result |
| --- | --- |
| Universal | 1091 passed (rerun on `79ab6c9`) |
| TypeScript | 0 errors |
| Rust | 42 passed (Rust sources last changed in `965e513`) |
| Rails | 857, 0 failures, 2 skips |
| Identity | 129 + 1 skip; 130 of 130 with real Rails |
| Rails browser tests | 42 of 44. **FAIL**: 2 old team tests expecting legal names and a platform-app row. One support-dialog test failed once and then passed (flaky) |
| Web audit | 25 pages at 3 widths, six languages on 3 pages: pass after the fixes. Chrome only; Safari and Firefox NOT TESTED |
| App layouts, headless | 216 checks, 6 pages, 6 sizes, 3 languages: pass |
| Native GUI | section 6 |

## 12. Platforms

| | Code | Build | Automated | Native GUI | Real device | Distribution |
| --- | --- | --- | --- | --- | --- | --- |
| Web | PASS | PASS (assets, production boot) | PASS, 2 old tests FAIL | – | NOT TESTED | BLOCKED (deploy) |
| macOS Apple Silicon | PASS | PASS (ad hoc) | PASS | c1 mostly PASS; final NOT TESTED | this Mac | BLOCKED |
| macOS Intel | PASS | BLOCKED (no target library) | NOT TESTED | NOT TESTED | NOT TESTED | BLOCKED |
| Windows | changed, unbuilt | BLOCKED | shared code only | NOT TESTED | NOT TESTED | BLOCKED |
| iOS | changed, unbuilt | BLOCKED (no Xcode) | shared code, layouts | NOT TESTED | NOT TESTED | BLOCKED |
| Android | changed, unbuilt | BLOCKED (no SDK) | shared code, layouts | NOT TESTED | NOT TESTED | BLOCKED |

No updater exists on any platform.

## 13. Commits

`37f4a8d` rollback fence · `965e513` single process, mobile, Windows · `5b304a1` browser tests · `62b0b95` native defects · `f96d742` receipts page · `4dc5571` buttons · `e7ab324` log redaction · `315c39f` decisions · `61aa7e9` smoke test · `8e850e5` CSP · `79ab6c9` wording, plus checkpoints. Branch `rollback/session-safe` = `dbd85e7`.

## 14. Artifacts (`ClaudeGenerated`)

| | Source | Executable SHA-256 | DMG SHA-256 |
| --- | --- | --- | --- |
| `overnight-c1` (superseded) | `f258e7a` | `e1aa3a3d0c853ad0bb34a6bf090ffbb1f30dd282e4c4583178f52835403c1b40` | – |
| **`overnight-c4`, identity `.qa.night2` (final)** | `79ab6c9` | `7b7fc6bb3d317fa461a7d60760ec48e727d4704a6129c9eff05c46fc57e573d8` | `48aa51e8bbb3e9fd1825a902ace14e47e09887d633fb3d5f386f324afb14a130` |
| `overnight-c2` (superseded), identity `.qa` | `4dc5571` | `6e67ad21f38b7afab55efd4c5cac03b5d551f186566fe474863a7409a18baf2d` | `25f8bfdbc2015767de0437fbebd05b96e335bb0c0936c622785e94c8989e1ef0` |
| `overnight-c3` (superseded), identity `.qa.night` | `f5466b5` (same client source as c2) | `de08a85d2904d68486ff5926c360ac011576ff7970ea8e28f0c51f5c122462ee` | `29aada0308592659fa7510bc963943172aea5c2361a7c248b9272e862cf2570d` |

Version 0.1.0, builds 100, 102 and 109, arm64, ad hoc, hardened runtime, no entitlements, preflight PASS. Rust 1.99.1, Node 24.22.1. Two builds of `79ab6c9` in separate target folders, same checkout path, are identical (bundles compared file by file). Another path was not tried.

## 15. External requirements

Developer ID and notary profile; Neon branch and roles; Render access; rustup targets; Xcode; Android SDK; a Windows machine; devices; approvals for merge, push, deploy.

## 16. Scheduling

No usage limit was reached. launchd was tried, could not read `~/Documents` (macOS privacy), and was removed. Working: in-session schedule (03:01, 08:01) and a detached waiter (03:07, 08:07). The waiter's access to the repository and to Claude, and the resume script in dry mode, were tested; **a real resume has not happened**. At 03:01 the in-session schedule fired while the session was idle; this was not a recovery from a limit. The waiter was then stopped, because it would have started a duplicate session. The 08:01 check remains.

## 17. Mistakes and deviations

1. 01:30: brought QA to the front while someone was using the Mac (it lost the front within seconds). Later GUI work waited for an idle desktop (2 minutes at 01:57, 10 from 02:10). At about 02:10 someone quit the QA app; I stopped.
2. One accessibility listing of the file panel printed folder names of your sidebar and two file names. Not captured or opened; the tool no longer reads panels.
3. A loose button match pressed "Back up now" (QA data only).
4. For the second-copy test the QA app was opened with `open -n` directly, not through `qa.mjs`.
5. Launching c2 over c1's sign-in caused the prompt.
6. The removed cache folders contained eight old QA app bundles; I listed them in the same command that removed them.
7. The first browser-test run may have opened visible Chrome windows; this was not checked. Later runs were headless.
8. A layout audit first reported success without leaving the welcome page; noticed and redone.
9. About 03:05 I stopped the display keep-awake; by 03:07 the screen had locked. The prompt was still blocking the desktop then (a SecurityAgent window was still listed afterwards), so no test was lost, but from then on the 08:01 check cannot run any GUI test unless you have unlocked the Mac.
10. Some times in the checkpoint file are estimates. Checkpoint and log commits have no attribution line.

## 18. Your decisions

1. Answer the prompt. 2. Undo of single edits, and redo: wanted? 3. Merge of `autonomous-development`. 4. Version number and release identity. 5. Keep 14 and 30 days for sign-ins? 6. RFC 5.8 items 4 and 9. 7. Installing toolchains.

## 19. Next steps

1. Dismiss the prompt.
2. With the desktop free, about 30 minutes: launch `overnight-c4` through `qa.mjs` and repeat section 6, including every NOT TESTED row.
3. Merge by the [plan](phase5.9-integration-plan.md), then close the rollback fence by the runbook.
4. Signing pair: confirm that an update does not ask for the keychain.
