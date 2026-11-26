# Four-agent audit evidence (2026-11-25) — what is published here

This folder holds the reports, findings, checklists, repro tests and short result summaries of the
four-agent audit. Local paths are replaced by `$WORKSPACE`, `$SCRATCH` and `$HOME`.

Not published (the repository is public): the full Rails/cargo/migration/rollback run logs and the
full-page web walkthrough screenshot. They contain machine-local paths and add nothing beyond the
pass/fail summaries in `billieweather-four-agent-audit-2026-11-25.md`. They remain on the auditing
Mac in the `billieweather-audit` worktree (commit `c3c895e`, branch `audit/four-agent-2026-11-25`).

Not integrated as code: `audit/fix-b2` (`7db883f`, S6 console logging of Categorize with AI failures).
The audit's Chief rejected S6 because `privacy.test.ts` forbids client logging; that decision stands.
