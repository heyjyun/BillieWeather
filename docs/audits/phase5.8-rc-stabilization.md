# BillieWeather / FinRx Phase 5.8: RC stabilization and release readiness

2026-11-24, branch `autonomous-development`, macOS 27.2, Apple Silicon. Nothing was pushed, merged, deployed or released, and Neon and Render were not contacted. Evidence: [evidence/2026-11-24-phase5.8](evidence/2026-11-24-phase5.8/).

## 1. Decision

| Scope | Decision |
| --- | --- |
| Production (overall product) | **NO-GO** |
| macOS external distribution | **NO-GO**: no signing identity, not notarized |
| macOS Apple Silicon user acceptance (isolated QA) | **CONDITIONAL GO**: start the checklist in section 10 |

- The P0 security defect is fixed and verified. It was wider than Phase 5.7 reported: website cookies had it too.
- **Native GUI acceptance is BLOCKED.** The desktop was in use, then locked, for the whole phase. No GUI flow was run in this RC.
- The database audit found crash-unsafe writes in 21 of 33 operations tested. All are fixed.

## 2. Baseline and candidate

The Phase 5.7 RC was `929c23a`; the branch head was `11e3187` (documents only). Rails 824 tests reproduced before any change. The main checkout's uncommitted work was not touched.

| Item | Value |
| --- | --- |
| Source | `e905b3b8589058f64ed60ebe0badf326048cca6c`, read back from the binary |
| Location | `ClaudeGenerated/phase5.8/BillieWeather QA.app` (outside the repository; the 5.7 RC is kept) |
| SHA-256 | `34993285a2806da43241b6e578bbf6af5ec8e6bf86f0104afa82cc8b93521efa` |
| Identifier | `com.billieweather.client.qa` in Info.plist, signature and binary |
| Architecture, SQLite, signature | arm64, 3.54.1, ad hoc (`spctl` rejected) |
| Preflight | PASS |

Commits: `ce73174` server revocation, `e5eed6e` app sign-out, `f3795d1` atomic writes, `c5eb5ce` open failures and durability tests, `f51d43b` OCR fallback, `e905b3b` web session refresh (**RC source**). The report commit that follows changes documents and one comment.

## 3. Security remediation: PASS

| Before | Now |
| --- | --- |
| App token valid up to 30 days after sign-out | Opaque token, one `user_sessions` row, checked on every request |
| **Copied website cookie still opened financial pages after sign-out (new finding)** | The cookie carries a secret bound to a row; sign-out ends every copy |
| No account-wide revocation apart from a password change | "Sign out other devices" in the app and on the website; password change and reset end everything else, including remember-me |
| Offline sign-out never reached the server | Only the SHA-256 digest is kept and retried. It can end that one session and opens nothing |

- Only digests are stored. A session is bound to a fingerprint of the password salt, so a sign-in racing a password change, or a password written outside Rails, cannot outlive it.
- Verified live: 71 of 71 requests started after sign-out were refused while six clients kept sending; five concurrent sign-outs agreed; revocation survived a restart; no token appeared in logs.
- The identity service accepts no session token on any endpoint. Its compatibility test had required a signed-out token to keep working; that is corrected.
- **Expected effect of release: everyone signs in once more**, because older tokens and cookies cannot be revoked individually. Local data is kept.
- Not covered: receipt capture tokens and OAuth platform tokens (separate credentials with their own revocation), and a session list. Rolling back to the old code brings the old defect back.

Dependencies: RustSec 0 vulnerabilities (6 existing warnings), npm 0, Ruby 0. Python was not audited again.

## 4. Database integrity: PASS (no GUI)

Each write operation was killed before its first, second, third… write; the book had to equal its state before or after.

| Found | Fixed |
| --- | --- |
| Category choice saved without its protection or record | One transaction |
| Edit lost its tags, or could not be undone | One transaction |
| A failed save, retried, could add the entry twice | Entry, tags and log together |
| Website download applied partly; a re-uploaded file blocked every later download | One transaction; the hash is released first |
| Two currencies mixed, or a raw error, when imports overlapped | Database guard, clear message |
| A saved import reported as failed | Corrected |
| A change of more than 5,000 entries refused | Limit 100,000 |
| Bulk category change logged the new value as the old one | Corrected |
| Active book could not open: another was opened and remembered silently | Stops, explains, offers Try again and Open another |
| Failed category or exclusion change showed nothing | Message |

Native tests passed: SIGKILL during writes (4 rounds, both journal modes), busy and stuck locks, disk full, damaged file, failing migration then retry, refused downgrade. Integrity and foreign keys stayed clean. 33 of the 42 new tests in `atomicity.test.ts` fail on the old code.

Open decision: a statement deleted on the website also removes this device's edits to its copy. That is the documented design and is unchanged.

## 5. Migration and rollback: PASS (isolated)

One additive migration, `20261125000100`. Up, repeat, down and up again: schema and data dumps identical. The previous release ran on the new schema: 57 tests, 0 failures. SQLite has no new migration, so the previous app opens the same books. Order: **migrate, then deploy Rails.** New code without the table fails closed. The runtime role needs DML on `user_sessions` and its sequence.

## 6. OCR: PASS (no GUI)

Fixed: cancelling a running Tesseract page **hung forever**, and nothing had a deadline (now 60 s to load, 90 s per page); failed pages got no fallback; a failing fallback discarded pages Vision had read; a page without text passed as read; a receipt with an unread page was accepted.

Both real engines were tested separately and as one chain: page-level fallback, full fallback, damaged, empty and truncated files, missing page acknowledgement, and repeats. Tesseract also ran in Chromium, and in WebKit 27.2 for the first time, with no outside requests. Not tested: the RC's own WebView, a first preparation under the RC's identity, and a cold start after a macOS update.

## 7. Native GUI evidence: BLOCKED

All 13 workflows are **BLOCKED**: login and logout; create and reopen; CSV; receipt; scanned PDF; review; persistence; restart; undo and protected edits; trash and permanent deletion; theme and language; keyboard; feature library and settings. Nothing else is counted in their place.

Package without GUI, identity `…client.qa.p58`: clean install, protection copy of an old-schema book and binary replacement **PASS**. The migration of that book through the UI, preferences, and OCR cold start are **NOT TESTED**.

## 8. Readiness matrix

| Gate | Status |
| --- | --- |
| Server revocation: app, website, account-wide | PASS |
| Local database reliability | PASS |
| Migration and rollback, isolated | PASS |
| OCR engines and fallback, outside the app | PASS |
| QA isolation and preflight | PASS |
| Rails 849 tests, 31,300 assertions (2 existing skips) | PASS |
| Universal 1071/1071, 0 skipped, with Chromium and real engines; TypeScript | PASS |
| Rust 39/39 | PASS |
| Identity 128 + 1 skip; 129/129 with real Rails | PASS |
| Native GUI, 13 workflows | BLOCKED |
| Upgrade through the GUI, OCR cold start in the RC | NOT TESTED |
| Protection copy failing at startup (exits without a message) | NOT TESTED |
| axe scan of the new dialogs, VoiceOver | NOT TESTED |
| Developer ID, notarization, stapling | BLOCKED (0 identities) |
| Render, Neon, real environment | BLOCKED |
| Intel, Windows, iOS, Android | NOT TESTED |

## 9. External blockers

1. An unlocked, free desktop or a person, for section 10.
2. Developer ID certificate and notarization credentials.
3. A Neon branch, read-only Render access and restricted roles; approval for `20261125000100`.
4. Approval to push, merge and deploy, each separately.
5. Toolchains and devices for the other platforms.

Architecture: [RFC](../architecture/rfc-phase5.8-hardening.md).

## 10. User acceptance checklist (about 25 minutes)

The backend commands were verified from scratch. From `billieweather-roadmap`:

```sh
(cd services/identity-api && uv sync --frozen)
ROOT=$(bin/billie-local init | tail -1); export BILLIE_LOCAL_ROOT=$ROOT BILLIE_MODULE_SYNC=1
bin/billie-local rails db:prepare && bin/billie-local identity -m identity_api.schema migrate
bin/billie-local rails server -p 33557 -b 127.0.0.1 &
bin/billie-local identity -m uvicorn identity_api.main:app --host 127.0.0.1 --port 38557 &
node clients/universal/scripts/qa.mjs launch "$(cd ../ClaudeGenerated/phase5.8 && pwd -P)/BillieWeather QA.app"
```

Use a synthetic account (code in `$ROOT/identity/outbox`) and `ClaudeGenerated/rc-fixtures`.

- [ ] Register, sign out, sign in. Stop Rails, sign out, start Rails, reopen the app, sign in.
- [ ] Name a database, quit, reopen: it is still there.
- [ ] CSV: cancel once, import once, import again (refused).
- [ ] Scanned PDF, then the receipt: review, confirm, and one cancel while it is reading.
- [ ] Damaged receipt: refused, nothing added.
- [ ] Quit, reopen: the count and total are unchanged.
- [ ] Change a category, undo in Activity, change it again: it stays yours.
- [ ] Trash, restore, empty the trash: it asks first, Cancel has the focus.
- [ ] Settings: Sign out other devices asks first; theme; language.
- [ ] Keyboard only: skip link, menus, dialogs, Escape.
- [ ] Feature Library: hide a module, restart, still hidden.
