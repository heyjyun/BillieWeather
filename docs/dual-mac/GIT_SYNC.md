# Git synchronization

GitHub (`heyjyun/BillieWeather`, public) is the only channel for source between the MacBook and the
Mac mini. **`origin/main` is the single long-lived shared branch.** `ops/git-sync.sh` wraps the safe
operations.

> Pushing `main` is a Git operation only: Render Auto-Deploy is **Off** and production deploys are
> started by hand. Before every push to `main`, confirm it is still Off; see
> [RELEASE_WORKFLOW.md → Render deployment](RELEASE_WORKFLOW.md#render-deployment-separate-from-git-sync).

## Model

```
 MacBook ──fetch/pull --ff-only──┐                ┌──fetch/pull --ff-only── Mac mini
         ──push (no force)───────┴─► origin/main ◄┴──push (no force)───────
                                        ▲
              short-lived feature/* fix/* audit/* branches, merged after review, then deleted
```

- `main` on GitHub is authoritative. A local `main` is only ever fast-forwarded to it or ahead of it
  by commits that have not been pushed yet.
- Temporary branches (`feature/*`, `fix/*`, `infra/*`, `audit/*`) are allowed when a task needs
  isolation or review. They start from the current `origin/main`, are reviewed, merged into `main`,
  and deleted only after `git cherry origin/main <branch>` shows nothing unique (or the unique part is
  deliberately rejected and the rejection is documented in `main`).
- `main` is the only permanent branch, locally and on GitHub. The integration, audit, release and
  rollback branches of November 2026 were consolidated into `main` and deleted on 2026-11-26.
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
ops/git-sync.sh pull                              # fast-forward main to origin/main; restarts a stale browser preview
git switch -c feature/x                           # optional; small changes may go straight on main
#  … commit …
ops/doctor.sh --tests                             # on the Mac mini (the MacBook may not have the full toolchain)
git fetch origin && git rebase origin/main        # or merge; resolve, retest
ops/git-sync.sh check origin/main..feature/x
git switch main && git merge --ff-only feature/x  # after review
ops/git-sync.sh push main                         # confirm Render Auto-Deploy is Off first
git branch -d feature/x                           # -d refuses if not merged; never -D on unique work
```

A feature branch may be pushed for review (`ops/git-sync.sh push feature/x`, or a PR); delete the
remote copy only after it is merged.

## Rules

- Never `push --force` (or `--force-with-lease`); never rewrite pushed history.
- Never discard unique work: before deleting a branch, worktree or tag, run
  `git cherry -v origin/main <ref>` and compare files; merge anything worth keeping into `main`
  (sanitized), or document in `main` why it was rejected. No archive branches or archive tags on GitHub.
- Never commit: `*.db*`, `*.bak`, `*.dmg`, `.app`, `target/`, `node_modules/`, `.env*` (except
  `.env.example`), `config/master.key`, `config/credentials/*.key`, statements, receipts, exported data.
- `ops/git-sync.sh push` refuses on scan findings; add a line to `ops/git-sync.allow` only after
  reviewing the exact file or string.
- Agents (`ops/agent-run.sh`) commit locally and never push; a person reviews and pushes.
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
