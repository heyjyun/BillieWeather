# RFC: hardening after Phase 5.8

Status: proposed, 2026-11-24. Nothing here is implemented.

| # | Proposal | Why | Risk and migration | Estimate |
| --- | --- | --- | --- | --- |
| 1 | Native message when the protection copy fails at startup | `setup` returns an error and the app exits without saying why | Must run before any window; needs a GUI test. No data change | 1 day |
| 2 | Single app instance | The protection copy assumes nobody else writes; two instances share files safely only through SQLite locks | Plugin; check deep links | 1 day |
| 3 | Website removals keep local edits: move the rows to the trash instead of deleting | Edits, tags and links on the copy are lost | Product decision; the sync must not bring trashed rows back | 2–3 days |
| 4 | List of signed-in devices with single revocation | `user_sessions` already holds the data; a label column would be needed | Additive column; privacy text | 2 days |
| 5 | Lint rule: financial writes only through `transaction` | Keeps the crash safety of Phase 5.8; `atomicity.test.ts` covers today's operations only | Allow-list for single-row writes | 1 day |
| 6 | Split `store.ts` and `ledger.ts` (about 1,300 and 1,500 lines) by area | Reviews are slow | Move only, no behaviour change, after release | 3 days |
| 7 | One conformance suite for Rails `Finance::*` and `finance-core` | Categories, kinds and duplicates exist twice; shared fixtures cover part | Tests only; differences become decisions | 4–5 days |
| 8 | Error codes (never values) counted per build | Import and open failures are visible only to the person | Opt-in, privacy review | 2 days |
| 9 | Receipt capture tokens follow account-wide revocation | Sign out other devices leaves them valid (upload only, 365 days) | Product decision: shortcuts would need a new token | 0.5 day |

Order: 1 and 2 before distribution; 3, 4 and 9 are product decisions; the rest can follow the release. No rewrite is recommended.
