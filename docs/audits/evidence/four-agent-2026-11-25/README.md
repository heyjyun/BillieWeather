# Four-agent audit evidence (2026-11-25) — what is published here

This folder holds the reports, findings, checklists, repro tests, result summaries and the full run
logs of the four-agent audit. Local paths are replaced by `$WORKSPACE`, `$SCRATCH`, `$HOME` and
`$TMPDIR`.

Full run logs (added 2026-11-25 during the branch consolidation, from `audit/four-agent-2026-11-25`
@ `c3c895e`): `chief/final-*` and `chief/regress-*` (Rails, cargo, cargo plugin, tsc, vitest),
`agent-b/rails-integration.log`, `agent-b/tsc.log`, `agent-b/phase3/tsc-final.log` and
`agent-c/logs/` (Rails, cargo, pytest, remigrate, rollback, tsc, vitest). Before they were committed
they were scanned for credentials, connection strings, e-mail addresses, card and account numbers and
machine paths; the only change was the path replacement above. The test data in them is synthetic.

Not published: `agent-b/web-addsync.png`, a 1280×36968 full-page capture of the development-mode
Rails routing-error page (a route table). It shows nothing about the audited behavior that
`agent-b/web-walkthrough.log` does not already record.

Where `c3c895e` and this folder differ in `walk.mjs`, `walk2.mjs`, `vitest-tail.log`,
`brakeman.txt`, `final-vitest.log` and `regress.sh`, the versions here are the sanitized ones.

The audit branch, its worktree and the scratch `audit/fix-*` branches were deleted after this
integration; `main` is the only branch.

## Rejected: `audit/fix-b2` (`7db883f`)

Not integrated as code, by decision. S6 (“Log unexpected Categorize with AI failures”) added a
`console.error` with the error's name and message to `AiCategorizePanel.tsx` and loosened
`privacy.test.ts` to allow exactly that call. The audit Chief rejected it: `privacy.test.ts` forbids
client console logging everywhere, because a logged error can carry transaction text into browser or
system logs, and an exception for one file weakens a guard that protects financial data. The person
still sees the same error message without the log. That decision stands.

The only other content of `7db883f`, `agent-b/rc3-native-checklist.md`, is already in this folder;
the version here differs only in its last paragraph, which records the S6 rejection instead of
expecting the console log. The commit was not merged and the branch was deleted.
