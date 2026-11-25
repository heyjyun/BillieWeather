# Architecture decision: keep Rails as the system of record, extend FastAPI by boundary

Status: recommended, 2026-11-25. No rewrite was done. Deciding belongs to the owner.

## What exists (measured on the branch)

| Part | Size | Owns |
| --- | --- | --- |
| Rails 8.1 (Bullet Train) | 13,600 lines Ruby, 88 views, 60 tables, 81 foreign keys, 78 check constraints | website, sessions (`user_sessions`), web financial data, client API |
| identity-api (FastAPI) | 2,200 lines Python, 129 tests (130 with Rails) | registration, email verification, Google sign-up; its own `identity` schema |
| Universal client | 34,500 lines TypeScript with packages, 2,300 lines Rust | local ledgers (SQLite, schema 9), import, OCR, offline use |
| Shared rules | `packages/finance-core` and Rails `Finance::*`, tied by shared JSON fixtures run on both sides | categories, kinds, duplicates, receipts, ledger scenario |

Verified as already sound: owner-composite foreign keys on every financial table (a row cannot point at another person's row), additive migrations, one transaction per financial change on the device, server-side sessions, guarded database targets.

## Decision

1. **Rails stays the single writer of financial and session data.** A second writer would duplicate the invariants that the foreign keys, triggers and models hold today.
2. **FastAPI keeps identity and takes new, separable services** (OCR or AI gateways, forecasting), each with its own schema or no database.
3. **The app does not change when the backend does**: `/api/client/v1` is the contract. A later move is done behind it.

## If a full move to FastAPI is ever wanted

| Step | Exit criterion |
| --- | --- |
| A. Contract tests for `/api/client/v1` run against any backend | Rails passes them in CI |
| B. Read-only endpoints in FastAPI (finance read, rules, categories) on a read role | identical answers for the shared fixtures and a synthetic database |
| C. Session checking in FastAPI against `user_sessions`, issuing stays in Rails | revocation suite passes on both |
| D. Writes, one aggregate at a time, Rails endpoint removed in the same release | row fingerprints equal before and after |
| E. Website: a new front end or Rails as the presentation layer only | product decision |

Estimate: A 3–5 days, B 1–2 weeks, C 1 week, D 4–6 weeks, E several months (88 views, six languages, accounts administration). Benefit today: one language less to run. Risk: every invariant is rebuilt. **Recommendation: do A now, stop there** until a concrete need appears.

## Not done on purpose

- Splitting `store.ts` and `ledger.ts` (RFC 5.8 item 6): move-only, better after a release than in the night before one.
- Undo of single manual edits and redo: the data for undo exists for edits made in the editor, not for quick category changes; there is no redo anywhere. Product decision.
- Device list with single revocation (RFC 5.8 item 4) and receipt tokens following account-wide revocation (item 9): product decisions.

## Session lifetime

30 days absolute, 14 days without use, password change and "sign out other devices" at once. Offline sign-out: the device deletes the token, keeps a digest, and retries at start, when the network returns and every minute while open. **Fundamental limit**: while the device cannot reach the server, a copy of its token made earlier works until the retry, the password change, or at most 30 days (14 if unused). Device-bound tokens would not help against a copy of the same keychain; shorter absolute lifetimes would sign everybody in more often. Proposed if wanted: rotate the token on use with reuse detection, after the first release.
