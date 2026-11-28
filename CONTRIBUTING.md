# Contributing to BillieWeather

## Branch model: main only

All development happens directly on `main`, the single branch both locally and on GitHub. No feature,
development, release, or temporary branches are created. Releases are annotated `vX.Y.Z` tags on
`main` commits, and rollbacks target commits in `main`'s history.

One-time setup in each clone turns on the hooks that enforce this:

```sh
git config core.hooksPath .githooks
```

## Making a change

```sh
ops/git-sync.sh pull                                   # fast-forward main
ops/main-commit.sh claim <label> <paths you will edit>
#  … edit, then run the relevant tests (see below) …
ops/main-commit.sh commit <label> -m "Describe the change" <paths>
ops/main-commit.sh release <label>
ops/git-sync.sh check origin/main..main                # secret/data scan before pushing
ops/git-sync.sh push main                              # only with the owner's authorization; never --force
```

`ops/main-commit.sh` serializes Git operations across concurrent sessions. It commits only the paths
you name, so other people's uncommitted work is left alone. The full rules for concurrent humans and
AI sessions are in [AGENTS.md](AGENTS.md).

## Tests

| Area | Command |
| --- | --- |
| Rails | `RAILS_ENV=test bin/rails db:test:prepare && RAILS_ENV=test bin/rails test` (local test database) |
| Universal Client | `cd clients/universal && npx tsc --noEmit && npx vitest run && npx vite build` |
| Native shell | `cd clients/universal/src-tauri && cargo test` |

There is no QA environment, QA app, QA server, or QA database branch. Tests run against the current
`main` code on disposable resources (the Rails test database, temporary local PostgreSQL clusters,
synthetic fixtures, headless browsers, temporary SQLite files) and clean up after themselves. Two
runtimes exist: Development (with the Dev app) and Production (with the Stable app). See
[AGENTS.md](AGENTS.md).

Migrations are append-only. Never edit or renumber a Rails or SQLite migration that is already on
`main`.

## Deployment

A push to `main` does not deploy. Production deploys and Stable app releases are manual, owner-run
steps from a tagged commit. See [docs/dual-mac/RELEASE_WORKFLOW.md](docs/dual-mac/RELEASE_WORKFLOW.md).
