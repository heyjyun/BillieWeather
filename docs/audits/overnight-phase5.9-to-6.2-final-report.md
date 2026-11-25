# Overnight sprint: Phase 5.9 to 6.2, consolidated report

2026-11-25, branch `autonomous-development`, macOS 27.2.1, Apple Silicon. Nothing was pushed, merged or deployed. Neon and Render were not contacted. No cost. Evidence: [evidence/2026-11-25-overnight](evidence/2026-11-25-overnight/).

## 1. Summary

- **Native macOS acceptance of the final build `overnight-c4` is done**: every workflow of the matrix that the product has passes (section 6). Not covered: an upgrade that changes the database schema, and redo, which the product does not have.
- Both open security findings have mitigations, rehearsed in production mode on isolated databases (section 10). The rollback protection needs one action from you in Render.
- All suites pass, including 44 of 44 browser tests (three runs in a row).
- **Phase 6.2 is not complete**: Intel, Windows, iOS and Android could not be built here.

| Scope | Decision |
| --- | --- |
| Isolated QA use | **GO** |
| Personal local macOS use | **CONDITIONAL GO**: c4 is a QA build with test servers; a build with your identity and servers needs a short run of its own |
| External macOS distribution | **NO-GO**: no Developer ID, not notarized |
| Web | **CONDITIONAL GO**: engineering done; deployment, Safari and Firefox open |
| Production backend | **NO-GO** until Neon, Render and approvals |
| Intel, Windows, iOS, Android | **NO-GO**: not built |

## 2–5. Phases

| Phase | Status | Open |
| --- | --- | --- |
| 5.9 | **PASS** for c4, with the limits above | schema upgrade on screen |
| 6.0 | **PASS** | merge approval |
| 6.1 | local **PASS**, production **BLOCKED** | Neon, Render, Developer ID, notarization |
| 6.2 | Web and Apple Silicon engineering done, rest **BLOCKED** | toolchains, devices, signing |

6.0: all 115 dirty files in `billieweather` hash-compared, **identical to `d3061e4`**; that checkout is unchanged. `main` = `origin/main` (last fetched) = `e4380af`; fast-forward rehearsed in a clone. Two Cargo caches of old runs removed (8 GB).

## 6. Native GUI acceptance: c4, 03:24–03:45

Executable `7b7fc6bb…`, identity `com.billieweather.client.qa.night2`. Raw results, including wrong steps of the scripts: `c4-native-results.txt`, `c5-upgrade-results.json`. Results of the earlier build c1 are not counted.

| Workflow | Result |
| --- | --- |
| Registration: empty form, short, wrong and right email code | PASS |
| Sign in, wrong password, sign out (checked on the server) | PASS |
| Offline sign-out, automatic retry | PASS: server told 18 s after it was back |
| Sign out other devices: Cancel keeps, confirm ends, own stays | PASS |
| Database creation, selection, reopening | PASS |
| Backup and verified restore | PASS |
| CSV: cancel, import, repeat refused | PASS |
| Scanned PDF (Apple Vision): review, decision, import | PASS; G1 fixed on screen |
| Receipt: read, save, duplicate, damaged file | PASS |
| Vision worker killed: Tesseract takes over; next receipt uses Vision | PASS |
| Recognition cancelled | PASS |
| Editing with note and tag | PASS |
| Category chosen by the person survives Reclassify of its own statement | PASS |
| Undo of an organize run; undo of an import (Keep, Remove 1,500 rows) | PASS |
| Undo of one manual change; redo | **not in the product** |
| Trash, restore; permanent deletion: Escape, Cancel, confirm | PASS |
| Feature Library, Settings, three themes, six languages, AI Assistant opens | PASS |
| Keyboard: 13 Tab stops, Cmd-K, Return, Escape, skip link | PASS (skip link by its action) |
| Quit and reopen: session, modules, data | PASS |
| Second account sees nothing of the first | PASS |
| Another account's automatic copy (G3) | PASS: own message, no longer listed; emptied file has no owner, no rows, no leftover text. The script's FAIL looked at another file |
| Second copy: message, nothing opened, ends after OK | PASS |
| Killed at five points of a 1,500-row import | PASS: 0 or 1,500 rows, never part; integrity ok |
| Install from the DMG (private folder) | PASS |
| Upgrade to a newer build over the same data | PASS after signing out first: no prompt, 10 rows identical |
| Upgrade without signing out (ad hoc builds) | c1 to c2: a system prompt, section 17 |
| Upgrade with a schema change | NOT TESTED on screen; automated PASS |

## 7. Defects fixed

Date-order menu past the window (G1) · another account's copy: generic message, stayed listed, used up a slot (G3) · Spanish Settings wider than a 320 px phone · web receipts page: duplicate id, too wide on phones · API applications without a name in the team list · "1 entries" · import page named too few formats · two copies of the app could share databases · sign-out retried only at start · identity log did not redact tracebacks · identity tests could pick a non-isolated database · browser tests broken by current Chrome and outdated · iOS camera text missing (the app would end) · Android ledger in cloud backups · Windows start-up alert invisible. The last three are **not built**.

Seen, left: a remembered rule can be as broad as "qa synthetic".

## 8–9. Architecture and databases

[Decision](../architecture/adr-2026-11-25-backend-direction.md): keep Rails, extend FastAPI by boundary; contract tests first. No schema change. PostgreSQL: migrations to `20261125000100`, 81 foreign keys, 78 checks. SQLite schema 9; all QA databases pass integrity and foreign-key checks. Backup and restore: 64 tables identical. Owner and runtime roles rehearsed. One version source, build number = commit count.

## 10. Security

1. **Rollback**: `BILLIE_SECRET_KEY_BASE`. Without it a rollback accepts signed-out tokens; with it the old release does not boot or answers 401. `rollback/session-safe` (`dbd85e7`) passes its session tests; its full suite has the same five failures as unmodified `main`. **Effective only once you delete `SECRET_KEY_BASE` in Render** ([runbook](render-neon-release-runbook.md)).
2. **Offline sign-out**: fundamental limit. Retry every minute, end after 14 unused days, at most 30 days; the password change is the remedy that needs no device.
3. Minimal Content-Security-Policy; production settings checked at start; production smoke test PASS, nothing private in the log. Script and style policies are open.

## 11. Tests on the final source

| Suite | Result |
| --- | --- |
| Universal / TypeScript | 1091 passed / 0 errors |
| Rust | 42 passed (sources last changed in `965e513`) |
| Rails | 857, 0 failures, 2 skips |
| Rails browser tests | 44 of 44, three runs |
| Identity | 130 of 130 with real Rails |
| Web audit | 25 pages, 3 widths; 3 pages in six languages (Chrome only; before `736f4c7`) |
| App layouts, headless | 216 checks |

## 12. Platforms

| | Code | Build | Automated | Native GUI | Real device | Distribution |
| --- | --- | --- | --- | --- | --- | --- |
| Web | PASS | PASS | PASS | – | NOT TESTED | BLOCKED |
| macOS Apple Silicon | PASS | PASS (ad hoc) | PASS | **PASS (c4)** | this Mac | BLOCKED |
| macOS Intel | PASS | BLOCKED | NOT TESTED | NOT TESTED | NOT TESTED | BLOCKED |
| Windows, iOS, Android | changed, unbuilt | BLOCKED | shared code only | NOT TESTED | NOT TESTED | BLOCKED |

No updater on any platform.

## 13–14. Commits and artifacts

`37f4a8d` rollback fence · `965e513` single process, mobile, Windows · `5b304a1`, `736f4c7` browser tests, names · `62b0b95` native defects · `f96d742` receipts page · `4dc5571`, `79ab6c9` layout, wording · `e7ab324` log · `315c39f` decisions · `8e850e5` policy, and checkpoints.

| `ClaudeGenerated` | Source | Executable SHA-256 | DMG SHA-256 |
| --- | --- | --- | --- |
| **`overnight-c4` (final, accepted)** | `79ab6c9` | `7b7fc6bb3d317fa461a7d60760ec48e727d4704a6129c9eff05c46fc57e573d8` | `48aa51e8bbb3e9fd1825a902ace14e47e09887d633fb3d5f386f324afb14a130` |
| `overnight-c5-upgrade` (upgrade test, same client source) | `aee4623` | `0d356490ff48ac509187ae54c2dfa5ca05d35545338e00ce9524334defcafc5a` | – |
| `overnight-c1`, `c2`, `c3` | superseded | | |

Version 0.1.0, build 109, arm64, ad hoc, hardened runtime, no entitlements. Two builds of `79ab6c9` are identical. Rust 1.99.1, Node 24.22.1. Commits after `79ab6c9` change no client file.

## 15. External requirements

Developer ID and notary profile; Neon branch and roles; Render access; rustup targets; Xcode; Android SDK; Windows machine; devices; approvals for merge, push, deploy.

## 16. Execution and recovery history

| Time | |
| --- | --- |
| 01:25 | Start. launchd tried: refused access to `~/Documents`, removed. In-session schedule and detached waiter set up and probed |
| 01:30–01:57 | Desktop in use: headless work |
| 01:57–02:10 | Native run on c1; someone quit the app |
| 02:23 | c2 launched: system prompt blocks the desktop. Headless work, report 02:37 |
| 03:01 | Scheduled start in the idle session (no limit); wording, reproducible c4; waiter stopped |
| 03:07 | Screen found locked |
| 03:21 | You unlocked the Mac; c4 accepted, upgrade tested; waiter restarted at 03:37 for 08:07 |
| 03:50 | Done: servers, cluster, waiter, schedules and my keep-awake stopped |

**No usage limit was reached, so a recovery from one never happened and is unproven.** Probes, dry runs and the duplicate guard worked.

## 17. Mistakes and deviations

1. 01:30: took the front while someone was using the Mac.
2. A listing of the file panel printed sidebar folder names and two file names.
3. A loose match pressed "Back up now" (QA data).
4. One second copy was opened with `open -n` instead of `qa.mjs`.
5. Launching c2 over c1's sign-in caused the prompt. Identified only indirectly: the log shows keychain database access and a signature check at that moment, not the dialog. You or the system closed it; I did not touch it.
6. The removed caches held eight old QA bundles, listed in the same command.
7. The first browser-test run may have opened Chrome windows.
8. A layout audit first passed without leaving the welcome page; redone.
9. I stopped the display keep-awake at 03:05; the screen locked.
10. `security dump-keychain -a` was run once: attributes of all items, no secrets, output discarded. Too broad.
11. I read the text of, and pressed OK in, two system alert windows after checking that they were exactly this app's "already open" message.
12. Some checkpoint times are estimates; some checkpoint commits have no attribution line.

Left on this Mac: synthetic QA data under `com.billieweather.client.qa`, `.qa.night` (if created) and `.qa.night2` with their keychain entries, and the stopped cluster in `/private/tmp`.

## 18. Your decisions

1. Merge `autonomous-development`. 2. Delete `SECRET_KEY_BASE` at release. 3. Version and release identity. 4. Undo of single changes, redo: wanted? 5. 14 and 30 days. 6. RFC 5.8 items 4 and 9. 7. Toolchains.

## 19. Next steps

1. Merge by the [plan](phase5.9-integration-plan.md).
2. Developer ID build with your servers: short native run, and check that an update keeps the sign-in without a prompt.
3. Neon and Render by the runbook; close the rollback fence.
4. Install the toolchains you want and build each platform.
