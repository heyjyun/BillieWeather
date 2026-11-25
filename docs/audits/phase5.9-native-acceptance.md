# BillieWeather / FinRx Phase 5.9: native acceptance and release engineering

2026-11-24/25, branch `autonomous-development`, macOS 27.2, Apple Silicon. Nothing was pushed, merged or deployed; Neon and Render were not contacted; the installed app and its data were not touched. Evidence: [evidence/2026-11-25-phase5.9](evidence/2026-11-25-phase5.9/).

## 1. Decisions

| Scope | Decision | Why |
| --- | --- | --- |
| Personal local macOS use | **NO-GO** | No native workflow was run on the final candidate |
| Isolated QA use | **CONDITIONAL GO** | Suites, preflight and backend checks pass; this is the build to accept with section 7 |
| External macOS distribution | **NO-GO** | No Developer ID, not notarized, native acceptance incomplete; a distribution build has another identity and servers, so it needs its own acceptance |
| Production backend | **NO-GO** | Rehearsed only in isolation; Neon, Render and approvals outstanding |
| Windows, iOS, Android, Intel | **NO-GO** | NOT TESTED |

**Native GUI acceptance is not complete.** The objective of this phase was not reached. Permission to use the desktop was given three times, but it was then in use each time (other apps in front, live input), so testing stopped as agreed.

## 2. Baseline and candidate

| | Phase 5.8 RC | Phase 5.9 candidate |
| --- | --- | --- |
| Source | `e905b3b8589058f64ed60ebe0badf326048cca6c` | `f4902babe7a978bd40e616dee9023ee94516e6f7` |
| Executable SHA-256 | `34993285a2806da43241b6e578bbf6af5ec8e6bf86f0104afa82cc8b93521efa` | `1c7109bb08508c98a227db356b90f5d753f30371ba2b42a2d7e7ec3ea9c7b824` |
| Location in `ClaudeGenerated` | `phase5.8` | `phase5.9`, app and DMG (`phase5.9-candidate1` is a superseded build) |
| Identity, keychain, data | `com.billieweather.client.qa` | same |
| Servers | 127.0.0.1:33557 and :38557 | same |
| Signature | ad hoc | ad hoc, hardened runtime |
| Preflight | PASS | PASS |
| Started | yes | **never** |

## 3. Native acceptance matrix

| Workflow | 5.8 RC `e905b3b` | Candidate `f4902ba` |
| --- | --- | --- |
| Registration: empty form, wrong code, right code | PASS (one defect, U1) | BLOCKED |
| Login, logout, revocation, other devices | BLOCKED | BLOCKED |
| Database creation | PASS | BLOCKED |
| Reopen and persistence | BLOCKED: Cmd-Q quit once, reopening was not checked | BLOCKED |
| CSV | BLOCKED | BLOCKED |
| Receipt image | BLOCKED | BLOCKED |
| Scanned PDF | BLOCKED | BLOCKED |
| OCR review and confirmation | BLOCKED | BLOCKED |
| Editing, classification, protection, undo | BLOCKED | BLOCKED |
| Trash, restore, permanent deletion | BLOCKED | BLOCKED |
| Settings and Feature Library | BLOCKED | BLOCKED |
| Theme and language | BLOCKED | BLOCKED |
| Keyboard and focus | BLOCKED beyond registration (typing, first invalid field, heading focus) | BLOCKED |

Observed on the 5.8 RC: no data, session or keychain item before; after registration the session is in the QA keychain service and the data folder is 0700. Candidate 1 (`7a4c4b6`) started over that database and opened no file of the shipped app; its screens were not read.

## 4. Changes

| # | Found | Status |
| --- | --- | --- |
| U1 | In the RC: a short verification code answered "Check the highlighted fields." twice | Fixed in six languages, regression test. **Not seen on screen** |
| U2 | A failed protection copy ended the app without a message | System alert in six languages, nothing opened; text tested. **The alert itself was not seen** |
| T1 | Feature Library tests depended on the caller's `BILLIE_MODULE_SYNC` | Fixed |
| P1 | No packaging step | `scripts/package.mjs`: DMG, manifest, release gates; exit 2 while blocked |

## 5. Security and data

- **Authentication: PASS on the isolated server**, NOT TESTED through the app: online sign-out, offline digest, other devices, restart, expiry, password change, tampered tokens, migration from the previous architecture. A revoked website cookie was not repeated in this phase (Phase 5.8: PASS).
- **Limit while offline**: the server does not know about an offline sign-out. Until the device reconnects, a copied token works, for at most its 30 days. This device deletes its token at once and keeps only a digest. A device that is itself offline keeps its local data readable after "Sign out other devices", and that cannot be changed remotely. The password change is the remedy that does not depend on the device.
- **Data: PASS on the server** (28 financial tables, three with rows, identical fingerprints through migration, release, rollback and forward; backup restored identically). **Local databases**: covered by the existing automated tests only. GUI upgrade, preferences, OCR cancellation, crash and restore through the app: NOT TESTED.
- Rolling the server back accepts signed-out tokens again (rehearsed).

## 6. Regression, packaging, repository

Universal 1081/1081 · TypeScript 0 · Rust 41/41 · Rails 849, 0 failures, 2 existing skips · identity 128 + 1 skip, 129/129 with real Rails. All on `f4902ba`.

DMG `d4a333a3e7a1acdeeed3eb4358fdb9a0b8c0ec3e6ededb4f691e17024f49411e`, contains the same executable. Two builds of the commit are identical. Entitlements: none. `spctl` rejects it. Signing, notarization, stapling: **BLOCKED** (0 identities). Version and build are both 0.1.0; a release needs a decision on numbering.

Plans: [merge](phase5.9-integration-plan.md), [production](phase5.9-production-deployment-plan.md), [install and upgrade](phase5.9-macos-install-upgrade-rollback.md). The RFC was read; only its item 1 (U2) was done.

Deviations: after the QA window had lost the front, one script brought it forward again; scripts now stop. One full-screen capture was taken and deleted unviewed; only window captures followed. One identity run used the default local test database. One cleanup command with an unsafe variable was refused before it ran; nothing was deleted by it.

## 7. To finish acceptance (about 40 minutes, undisturbed)

From `billieweather-roadmap`, start the backend as in [Phase 5.8](phase5.8-rc-stabilization.md) section 10, then `node clients/universal/scripts/qa.mjs launch "$(cd ../ClaudeGenerated/phase5.9 && pwd -P)/BillieWeather QA.app"` and bring its window to the front. Use that checklist, plus: a 6-digit code is explained; offline sign-out then reconnect; a second device signed out; the OCR cancel. The QA data folder holds one synthetic account of this phase; with a new server it asks to sign in again.

## 8. External authorization checklist

1. The desktop, undisturbed, for section 7. 2. Developer ID, notarization profile, version numbering. 3. Neon branch and roles, Render read access, approval for `20261125000100`. 4. Merge, push and deploy, each separately. 5. Toolchains and devices for the other platforms.
