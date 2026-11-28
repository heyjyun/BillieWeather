# Instructions for AI coding sessions (Codex, Claude Code, and others)

These rules are permanent and apply to every session that works on BillieWeather.

## Main-only development

`main` is the only development and integration branch. All work goes directly on `main`: features,
fixes, UI/UX changes, refactoring, and database migrations.

- Do not create branches of any kind: feature, development, release, experimental, or temporary.
- Do not create Git worktrees or develop on detached HEAD unless the owner explicitly authorizes it for
  a specific task. An authorized worktree is for testing only. Anything worth keeping is committed on
  `main`, and the worktree is removed when the task ends.
- Commit completed, verified changes to `main` in small steps.
- Push only under the push policy in [docs/dual-mac/GIT_SYNC.md](docs/dual-mac/GIT_SYNC.md): the owner
  authorizes each push, `ops/git-sync.sh push main` runs, and force-push is never used.
- Never force-push, `reset --hard`, `clean -f`, `checkout -- .`, or otherwise discard work you did not
  create.

Hooks in `.githooks/` enforce this once `git config core.hooksPath .githooks` is set. `pre-commit`
refuses commits that are not on `main`. `reference-transaction` refuses to create any other branch.
Owner-authorized exceptions are listed one per line in
`$(git rev-parse --git-common-dir)/billie-coordination/allowed-branches`. Do not add to that file
yourself.

## Working alongside other sessions

Several Codex and Claude Code sessions, and the owner, may edit the same checkout at the same time.

1. **Before editing**, claim the files or directories you will change:
   `ops/main-commit.sh claim <session-label> <path>...`. If a path is already claimed by someone else,
   leave it alone and work on something else, or tell the owner.
2. **Assume uncommitted changes you did not make belong to someone else**, including the owner's
   manual UI/UX edits. Never revert, reformat, stage, stash, or commit them.
3. **Commit only your own paths**, through the serialized wrapper:
   `ops/main-commit.sh commit <session-label> -m "<message>" <path>...`. It holds a repository-wide
   lock, refuses paths claimed by other sessions, and commits exactly the listed paths. Anything
   another session has staged stays staged. Never use `git add -A`, `git add .`, or `git commit -a`.
4. **Run any other Git command that changes the index or refs** under the same lock:
   `ops/main-commit.sh lock <session-label> -- git <command>`. This includes pull, merge, rebase,
   stash, and checkout.
5. **Coordinate migrations.** Claim `db/schema.rb` before adding a Rails migration, and claim
   `clients/universal/src-tauri/migrations` before adding a SQLite migration. Never edit or renumber
   a migration that is already on `main`, because installed apps verify migration checksums.
6. **When you finish**, release your claims: `ops/main-commit.sh release <session-label>`.

## Environments derive from `main`, not from branches

One branch does not mean one runtime. Development, QA, production, the Dev app, and the Stable app
each run a specific commit or tag of `main`:

| Environment | Source | Data |
| --- | --- | --- |
| Development servers | the working tree of `main` | the synthetic Neon `development` branch, or the isolated local cluster |
| QA | a pinned `main` commit, in the QA bundle IDs `com.billieweather.client.qa.*` | the local test database and QA SQLite |
| Dev app | a `main` build installed with `ops/install-dev.sh` | Dev data only |
| Stable app | a `vX.Y.Z` tag on `main`, built by `ops/release-build.sh` and installed by the owner | the owner's real data. Never replace or modify it from a session |
| Production (Render) | a tagged commit, deployed **manually** by the owner | real data. Auto-deploy is off; a push to `main` never deploys |

Never deploy to production, replace the installed Stable app, or touch real financial records from an
AI session. Tests use the local test database, not Neon production.

Details: [docs/dual-mac/GIT_SYNC.md](docs/dual-mac/GIT_SYNC.md),
[docs/dual-mac/RELEASE_WORKFLOW.md](docs/dual-mac/RELEASE_WORKFLOW.md),
[docs/dual-mac/DATABASE_ISOLATION.md](docs/dual-mac/DATABASE_ISOLATION.md).
