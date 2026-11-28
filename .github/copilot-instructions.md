# Instructions for VS Code coding agents (Copilot and others)

Follow [AGENTS.md](../AGENTS.md). It is the single source of rules for every AI session. In short:

- `main` is the only branch. Do not create branches, Git worktrees, or detached-HEAD checkouts. The
  hooks in `.githooks/` refuse them, and CI fails on any pushed branch other than `main`.
- Claim files with `ops/main-commit.sh claim` before editing. Commit only your own paths with
  `ops/main-commit.sh commit`. Never touch other people's uncommitted changes.
- There is no QA environment. Test on disposable resources only. Never deploy Production, replace the
  Stable app, or push without the owner's authorization.
