# Git synchronization

GitHub (`heyjyun/BillieWeather`, public) is the only channel for source between the MacBook and the
Mac mini. **`origin/main` is the single long-lived shared branch.** `ops/git-sync.sh` wraps the safe
operations.

> Pushing `main` is a Git operation **and** currently triggers a Render production deploy. Read
> [RELEASE_WORKFLOW.md → Render deployment](RELEASE_WORKFLOW.md#render-deployment-separate-from-git-sync)
> before every push to `main`.

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
  deliberately rejected and preserved, see below).
- No permanent integration branch. `autonomous-development`, `consolidated-main` and `infra/dual-mac`
  were integration branches until 2026-11-25; they are fully merged and are not used for new work.
- `rollback/*` branches are the one kept exception: deployable fallbacks, not development lines.

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
ops/git-sync.sh pull                              # fast-forward main to origin/main
git switch -c feature/x                           # optional; small changes may go straight on main
#  … commit …
ops/doctor.sh --tests                             # on the Mac mini (the MacBook may not have the full toolchain)
git fetch origin && git rebase origin/main        # or merge; resolve, retest
ops/git-sync.sh check origin/main..feature/x
git switch main && git merge --ff-only feature/x  # after review
ops/git-sync.sh push main                         # deploy warning above applies
git branch -d feature/x                           # -d refuses if not merged; never -D on unique work
```

A feature branch may be pushed for review (`ops/git-sync.sh push feature/x`, or a PR); delete the
remote copy only after it is merged.

## Rules

- Never `push --force` (or `--force-with-lease`) to `main` or `rollback/*`; never rewrite pushed history.
- Never discard unique work: before deleting a branch, worktree or tag, run
  `git cherry -v origin/main <ref>` and compare files; preserve anything unique (merge it, or keep an
  `archive/<date>/<name>` tag **pushed to GitHub** if it must survive this Mac).
- Never commit: `*.db*`, `*.bak`, `*.dmg`, `.app`, `target/`, `node_modules/`, `.env*` (except
  `.env.example`), `config/master.key`, `config/credentials/*.key`, statements, receipts, exported data.
- `ops/git-sync.sh push` refuses on scan findings; add a line to `ops/git-sync.allow` only after
  reviewing the exact file or string.
- Agents (`ops/agent-run.sh`) commit locally and never push; a person reviews and pushes.
- Tags are never pushed implicitly. `checkpoint/*` tags stay local unless asked.

## Verified state — 2026-11-25 22:58 CST (MacBook, after `git fetch origin --prune`)

**GitHub** — branches: `main` 899241e, `consolidated-main` 1656256, `archive/phase1a-checkpoint`
8f6d0a3, `rollback/session-safe` dbd85e7. **No tags on GitHub.**

Local `main` = `origin/main` = 899241e. All MacBook checkouts are clean.

| Ref | Where | Not in `origin/main` | Disposition |
| --- | --- | --- | --- |
| `main` | local + GitHub | — | the shared branch |
| `autonomous-development` (f595291) | local, worktree `billieweather-roadmap` | 1 commit, every file identical in main (ed74ccb) | merged by content; removable |
| `infra/dual-mac` (3afc9cb) | local, worktree `billieweather-dualmac` | none | merged; removable |
| `release/production-consolidated-2026-11-25` (63958b0) | local, worktree `/private/tmp/billie-release.*/source` | none | merged; removable once release verification is finished |
| `audit/fix-a`, `fix-a2`, `fix-b`, `fix-c`, `fix-c2` | local, scratch worktrees | none | merged; removable |
| `phase-1a-modular-shell` (2d3df08), `archive/phase1a-checkpoint` (8f6d0a3, also GitHub) | local main checkout `billieweather/` | patch-equivalent commit already in main | merged; removable (the checkout should switch to `main`) |
| `consolidated-main` (1656256) | GitHub only | none | merged; removable from GitHub |
| `audit/four-agent-2026-11-25` (c3c895e) | local, worktree `billieweather-audit` | 21 full run logs + 1 screenshot; main took the summaries on purpose (ed74ccb) | **keep** until tag `archive/2026-11-25/audit-four-agent` is on GitHub or the logs are judged disposable |
| `audit/fix-b2` (7db883f) | local, scratch worktree | client console logging (S6), **rejected** by the audit Chief (privacy.test.ts forbids client logging) | **keep** until tag `archive/2026-11-25/audit-fix-b2` is on GitHub |
| `rollback/session-safe` (dbd85e7) | local + GitHub | 2 commits, deliberately separate | **keep**: the documented Render rollback target |
| detached worktree `/private/tmp/billie-release.*/rollback` | dbd85e7 | = `rollback/session-safe` | removable after release verification |
| detached worktree `…/706fd939…/scratchpad/wt79` | 79ab6c9, in main | one untracked `seed63.test.ts`, byte-identical to main's `docs/audits/evidence/2026-11-25-phase6.3/seed.test.ts.txt` | removable |

The 17 local `archive/2026-11-25/*` and `checkpoint/*` tags point at every pre-consolidation tip. Only
`ClaudeGenerated/checkpoint-phase6.3/billieweather-pre-integration.bundle` backs any of them up
off-repo, and it predates c3c895e and 7db883f. Those two commits therefore exist **only on this
MacBook**. Pushing their two archive tags (needs authorization) is the preservation step before
any of those branches is deleted:

```sh
git push origin archive/2026-11-25/audit-four-agent archive/2026-11-25/audit-fix-b2
```

(Check the four-agent logs for machine paths first; ed74ccb kept them local for that reason.)

### Mac mini

Not inspectable from the MacBook. First setup: clone `main` per [MAC_MINI_SETUP.md](MAC_MINI_SETUP.md).
An existing clone: `git fetch origin --prune && git switch main && git merge --ff-only origin/main`,
then the divergence check above for any local branch.
