# Overnight sprint: how to resume

1. Full instructions, verbatim: `overnight-instructions-verbatim.md`. They apply in full (safety: section 9).
2. State: `overnight-progress.json` (next_exact_action). History: `overnight-execution.log`, `overnight-phase5.9-to-6.2.md`.
3. Work only in this worktree (`billieweather-roadmap`, branch `autonomous-development`). `../billieweather` is the user's dirty checkout: read only.
4. Never push, merge to main, deploy, or contact Neon/Render. No cost. QA app only via `clients/universal/scripts/qa.mjs` (identifier `com.billieweather.client.qa`).
   Verify pid + bundle id + window before any GUI action; capture only the QA window. Desktop use is authorized for this night only.
5. The user's private folders `../Statements`, `../Example` and Office files in `..` are never read. Fixtures: `../ClaudeGenerated/rc-fixtures`.
6. Isolated backend: `export BILLIE_LOCAL_ROOT=<root in overnight-progress.json>`, `bin/billie-local verify` before every suite.
7. Update the checkpoint files after each milestone; commit locally (attribution line in commit messages).
8. Scheduling: in-session cron 3:01 and 8:01, backup waiter (`~/Library/Application Support/BillieWeatherSprint`, 03:07/08:07). launchd was tried: refused access to ~/Documents.
   When finished: set `"sprint_complete": true`, kill the waiter (`waiter.pid`), remove that folder, CronDelete leftovers, kill the two `caffeinate -t` processes started for the sprint.
