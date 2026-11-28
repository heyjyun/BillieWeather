# Git synchronization

GitHub (`heyjyun/BillieWeather`, public) is the only channel for source between the MacBook and the
Mac mini. **`main` is the only branch, locally and on GitHub, and all development happens on it.**
`ops/git-sync.sh` wraps the safe sync operations, and `ops/main-commit.sh` coordinates concurrent
sessions working in the same checkout.

> Pushing `main` is a Git operation only: Render Auto-Deploy is **Off** and production deploys are
> started by hand. Before every push to `main`, confirm it is still Off; see
> [RELEASE_WORKFLOW.md → Render deployment](RELEASE_WORKFLOW.md#render-deployment-separate-from-git-sync).

## Model

```
 MacBook ──fetch/pull --ff-only──┐                ┌──fetch/pull --ff-only── Mac mini
         ──push (no force)───────┴─► origin/main ◄┴──push (no force)───────
                                        ▲
         every session commits directly on main (ops/main-commit.sh); no other branches
```

- `main` on GitHub is authoritative. A local `main` is only ever fast-forwarded to it or ahead of it
  by commits that have not been pushed yet.
- **Main-only development (permanent policy since 2026-11-28).** Features, fixes, UI/UX changes,
  refactors, and migrations are committed directly on `main`. Feature, development, release,
  experimental, and temporary branches are not created. Git worktrees and detached-HEAD work need the
  owner's explicit authorization for a specific task. They are used for testing only, and they are
  removed when the task ends.
- Enforced by `.githooks/` after `git config core.hooksPath .githooks`: `pre-commit` refuses commits
  off `main`, and `reference-transaction` refuses to create other branches. Owner-authorized exceptions
  are listed in `$(git rev-parse --git-common-dir)/billie-coordination/allowed-branches`.
- Isolation between concurrent sessions comes from file claims and a serialized commit lock, not from
  branches. See "Concurrent sessions" below and [AGENTS.md](../../AGENTS.md).
- The integration, audit, release, and rollback branches of November 2026 were consolidated into
  `main` on 2026-11-26. The `dev/*` branches were consolidated on 2026-11-28.
- Rollback targets are commits in `main`'s history, not branches (the session-safe rollback release
  `dbd85e7` is reachable from `main` through a content-free `-s ours` merge).

## Before every push: fetch and check for divergence

```sh
git fetch origin
git status -sb                                   # "ahead N" is fine; "behind" or "diverged" is not
git rev-list --left-right --count main...origin/main   # left = only local, right = only on GitHub
```

| Result | Meaning | Do |
| --- | --- | --- |
| `N 0` | local is ahead | `ops/git-sync.sh check origin/main..main`, then `ops/git-sync.sh push main` |
| `0 M` | GitHub is ahead | `ops/git-sync.sh pull` (fast-forward only) |
| `N M` | diverged (the other Mac pushed) | `git rebase origin/main` (local, unpushed commits only) or `git merge origin/main`; rerun the tests; then push. Never force. |

`ops/git-sync.sh push` runs the secret/data scan and uses a plain `git push` (no `--force`), so GitHub
rejects it if `main` moved in the meantime; fetch and repeat the table.

## Daily flow (either Mac)

```sh
ops/git-sync.sh pull                              # fast-forward main, check live services and restart a stale managed preview
ops/main-commit.sh claim <label> <paths>          # file-level ownership while you edit
#  … edit, test …
ops/main-commit.sh commit <label> -m "…" <paths>  # serialized; commits exactly these paths on main
ops/main-commit.sh release <label>
ops/doctor.sh --tests                             # on the Mac mini (the MacBook may not have the full toolchain)
git fetch origin                                  # divergence check (table above); rebase only unpushed local commits
ops/git-sync.sh check origin/main..main
ops/git-sync.sh push main                         # owner-authorized; confirm Render Auto-Deploy is Off first
```

## Concurrent sessions

Several Codex and Claude Code sessions, and the owner, may work in the same `main` checkout at the
same time. Branches are not used to separate them. The rules (full text in [AGENTS.md](../../AGENTS.md)):

- Claim before editing: `ops/main-commit.sh claim <label> <path>...`. A claim on a directory covers
  everything under it. Claims are stored in the shared Git directory, so every worktree sees them.
- Uncommitted changes you did not make belong to someone else, including the owner's manual UI/UX
  edits. Never revert, stage, stash, or commit them.
- Commit with `ops/main-commit.sh commit`. It takes a repository-wide lock and refuses paths claimed
  by another session. It commits only the listed paths (`git commit --only`), so changes other
  sessions have staged stay staged. `git add -A`, `git add .`, and `git commit -a` are not used.
- Run other index- or ref-changing Git commands under the same lock:
  `ops/main-commit.sh lock <label> -- git …`.
- Migrations: claim `db/schema.rb` before adding a Rails migration, and claim
  `clients/universal/src-tauri/migrations` before adding a SQLite migration. The wrapper enforces both.
  Migrations already on `main` are never edited or renumbered.

If the runtime check reports a problem after the fast-forward, `git` has already moved to the new
commit. Recheck with `ops/dev-services.sh check` after resolving the reported service or schema issue.

## Rules

- Never `push --force` (or `--force-with-lease`); never rewrite pushed history.
- Never discard unique work: before deleting a branch, worktree or tag (including legacy ones), run
  `git cherry -v origin/main <ref>` and compare files; merge anything worth keeping into `main`
  (sanitized), or document in `main` why it was rejected. No archive branches or archive tags on GitHub.
- Never commit: `*.db*`, `*.bak`, `*.dmg`, `.app`, `target/`, `node_modules/`, `.env*` (except
  `.env.example`), `config/master.key`, `config/credentials/*.key`, statements, receipts, exported data.
- `ops/git-sync.sh push` refuses on scan findings; add a line to `ops/git-sync.allow` only after
  reviewing the exact file or string.
- Agents (`ops/agent-run.sh`, interactive Claude Code / Codex) commit locally on `main` and never push
  without the owner's authorization for that push.
- Tags are never pushed implicitly. `checkpoint/*` tags stay local unless asked.

## Verified state — 2026-11-26 (MacBook, after consolidation)

See [CONSOLIDATION_2026-11-26.md](CONSOLIDATION_2026-11-26.md) for what was merged, rejected and
deleted, and what is still open.

## Syncing an older clone (Mac mini)

For a clone made before 2026-11-26. Nothing is deleted until it has been checked.

```sh
cd <path-to>/billieweather
git status --short                     # must print nothing; commit or stash local work first
git fetch origin --prune               # removes the deleted remote branches locally
git for-each-ref --format='%(refname:short)' refs/heads | grep -vx main | while read b; do
  echo "== $b"; git cherry -v origin/main "$b"     # only "-" lines, or nothing: merged
done
git switch main
git merge --ff-only origin/main        # fails if local main has unpushed commits: use the table above
git rev-parse main origin/main         # both lines must match
git branch -d <each branch the loop showed as merged>   # -d only; a "+" line is unique work: stop
git worktree list && git worktree prune
```

A branch with `+` lines holds work that is not on GitHub: rebase it onto `origin/main`, review, merge
into `main` and push (after the Render check), or document why it is dropped, before deleting it.
