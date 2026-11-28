# Claude Code instructions

BillieWeather is developed on a single branch, `main`. The rules for every AI session, Claude Code
included, are in AGENTS.md and are imported here:

@AGENTS.md

Claude Code specifics:

- Do not use `EnterWorktree`, `isolation: "worktree"` subagents, or `git worktree add` unless the owner
  explicitly authorizes it for the task at hand. The main-only hooks refuse to create the branch a
  worktree needs.
- Use your session ID prefix as the `ops/main-commit.sh` session label, for example
  `claude-190ddcd1`.
