# Branch consolidation — 2026-11-26

Goal (owner decision): `main` is the only permanent branch, locally and on GitHub. No audit or
archive branches are kept, and no new archive tags are created. Useful findings and sanitized
evidence live in `main`; rejected work is documented, not merged. Production deploys are manual
(Render Auto-Deploy Off). Nothing was deployed, Neon was not contacted, and no migration was run.

## What went into `main`

| Commit | Content |
| --- | --- |
| `9d91a47` | Dual-Mac docs: `main` is the single shared branch (written before this consolidation) |
| sanitized audit logs | The full Rails, cargo, pytest, remigrate, rollback, tsc and vitest logs from `audit/four-agent-2026-11-25` (`c3c895e`), with paths replaced by `$WORKSPACE`, `$SCRATCH`, `$HOME`, `$TMPDIR`. Scanned for credentials, connection strings, e-mail addresses and card or account numbers; none were found. See `docs/audits/evidence/four-agent-2026-11-25/README.md` |
| rollback merge | `-s ours` merge of `rollback/session-safe` (`4fde8c9`, `78fe22a`, `dbd85e7`). `main`'s files are unchanged (tree checked before and after); `dbd85e7`, the documented session-safe rollback release, is now in `main`'s history and stays on GitHub without its branch |
| deploy policy | `autoDeployTrigger: "off"` in both Render blueprints plus a test that keeps it; RELEASE_WORKFLOW, runbook, ARCHITECTURE, GIT_SYNC and MAC_MINI_SETUP describe manual deploys and the single-branch model |

## Reviewed and not merged

| Ref | Why |
| --- | --- |
| `audit/fix-b2` `7db883f` | **Rejected** (S6 client console logging; `privacy.test.ts` forbids it). Rationale in the evidence README. Its checklist file was already in `main` in corrected form |
| `audit/four-agent-2026-11-25` `c3c895e` → `agent-b/web-addsync.png` | Dev-mode Rails route-table capture, no evidence value |
| `c3c895e` versions of `walk.mjs`, `walk2.mjs`, `vitest-tail.log`, `brakeman.txt`, `final-vitest.log`, `regress.sh` | `main` already holds the sanitized versions |
| `autonomous-development` `f595291` | Every evidence file is identical in `main`; the one differing file (`render-neon-release-runbook.md`) is newer in `main` |
| `phase-1a-modular-shell` `2d3df08`, `archive/phase1a-checkpoint` `8f6d0a3` | Patch-equivalent commits already in `main` (`git cherry` shows `-` only) |
| `consolidated-main`, `infra/dual-mac`, `release/production-consolidated-2026-11-25`, `audit/fix-a`, `fix-a2`, `fix-b`, `fix-c`, `fix-c2` | No commits outside `main` |

## Deleted

- GitHub: `consolidated-main`, `archive/phase1a-checkpoint`.
- Local branches: `audit/fix-a`, `audit/fix-a2`, `audit/fix-b`, `audit/fix-b2`, `audit/fix-c`,
  `audit/fix-c2`, `audit/four-agent-2026-11-25`, `infra/dual-mac`,
  `release/production-consolidated-2026-11-25`, `rollback/session-safe`, `phase-1a-modular-shell`,
  `archive/phase1a-checkpoint`.
- Worktrees: `billieweather-audit`, `billieweather-dualmac`, the two release worktrees under
  `/private/tmp/billie-release.*`, six `audit/fix-*` scratch worktrees and the detached `wt79` (its one
  untracked file is byte-identical to `docs/audits/evidence/2026-11-25-phase6.3/seed.test.ts.txt`).
- The pre-existing local `archive/2026-11-25/*` and `checkpoint/*` tags were left as they were (local
  only; nothing new was tagged or pushed).

Second pass (after the push, see below):

- GitHub: `rollback/session-safe`.
- Local branch: `autonomous-development` (`f595291`, removed with `-D` because its one commit is in
  `main` by content, not by ancestry).
- Worktree: `billieweather-roadmap`.

The primary checkout `billieweather/` now has `main` checked out and is the only worktree.

## Completed on 2026-11-26

All open items from the first pass of this document are done.

| # | Item | Status |
| --- | --- | --- |
| 1 | Render Auto-Deploy for `web` set to **Off** | ✅ Done. Confirmed by the owner in the Render dashboard before `main` was pushed. Both blueprints also set `autoDeployTrigger: "off"` (`render.yaml`, `services/identity-api/render.yaml`), and `test/lib/billie_runtime_settings_test.rb` keeps them that way |
| 2 | Push `main`, delete `rollback/session-safe` on GitHub | ✅ Done. `6b13c3f` pushed with a normal (non-force) push on 2026-11-26 00:26 -0600. `dbd85e7` is an ancestor of `origin/main`. `rollback/session-safe` is gone from GitHub |
| 3 | Remove `autonomous-development` and the `billieweather-roadmap` worktree | ✅ Done after a backup (see below). The local QA Puma (`:3000`) and identity-api (`:8100`) servers now run from the primary checkout `billieweather/` |
| 4 | Mac mini sync | ⏳ **Not done yet.** See [Mac mini: remaining steps](#mac-mini-remaining-steps-not-yet-verified) |

Nothing was deployed to Render by this work, Neon was not contacted, no migration ran, no user data
was touched and the installed application was not rebuilt.

## Verified architecture (MacBook, 2026-11-26)

Checked on the MacBook with `git` and the GitHub API after cleanup:

| Check | Result |
| --- | --- |
| `git branch -a` | `main`, `origin/main` (and `origin/HEAD -> origin/main`) only |
| GitHub branches (`gh api repos/heyjyun/BillieWeather/branches`) | `main` only; it is the default branch |
| `git rev-parse main origin/main` and `git ls-remote origin` | Same commit for local `main`, `origin/main` and GitHub `main` |
| `git worktree list` | One worktree: `billieweather/` on `main` |
| `git merge-base --is-ancestor dbd85e7 origin/main` | True. The session-safe rollback release is in `main`'s history |
| Render blueprints | `autoDeployTrigger: "off"` in both |

The model: `main` is the only permanent branch on both Macs and on GitHub. Work happens on `main`
(or a short-lived local branch that is merged and deleted the same day), is checked with
`ops/git-sync.sh check`, and is pushed with `ops/git-sync.sh push main`. A push no longer deploys;
production deploys are started by hand in Render (see [RELEASE_WORKFLOW.md](RELEASE_WORKFLOW.md)).
Rollback is by commit (`dbd85e7`), not by branch.

## Backup of the removed branch and worktree

Before `autonomous-development` and `billieweather-roadmap` were removed, they were saved outside the
repository (not on GitHub) in:

```
<workspace>/BillieWeather/ReleaseVerification/legacy-roadmap-worktree-2026-11-26/
```

(`<workspace>` is the folder that contains the `billieweather/` checkout on the MacBook.)

| File | Content |
| --- | --- |
| `autonomous-development.bundle` | Full-history Git bundle of `refs/heads/autonomous-development` at `f595291`. `git bundle verify` reports a complete history. SHA-256 `fbc3864494af1fa65e977c3a54f03c1c395081b847f8f92c0d155d8f81ba6674` |
| `autonomous-development.HEAD` | The branch tip: `f595291e0b087c94734e72f4ccbc4c7bdfc7941c` |
| `worktree-ignored-evidence.tar.gz` | The worktree's git-ignored files (`coverage/` and other local evidence, 393 entries). SHA-256 `b400a9a41a4999fe5ede18f8c2ee02dffd6a7193aab340cfd076cb2aaac388e7` |
| `qa-puma-server.log`, `qa-identity-api.log` | Logs of the QA servers that ran from that worktree |

This folder is local to the MacBook and is not synced. It may contain local paths and test output;
do not upload it.

### Recovery

```sh
cd <workspace>/BillieWeather/billieweather
B=../ReleaseVerification/legacy-roadmap-worktree-2026-11-26
shasum -a 256 "$B/autonomous-development.bundle"        # compare with the value above
git bundle verify "$B/autonomous-development.bundle"
git fetch "$B/autonomous-development.bundle" autonomous-development:autonomous-development
git rev-parse autonomous-development                    # must print f595291…
# Only if a worktree is really needed:
git worktree add ../billieweather-roadmap autonomous-development
tar xzf "$B/worktree-ignored-evidence.tar.gz" -C ../billieweather-roadmap
```

`f595291` has no content that `main` lacks (see the table above), so recovery should only be needed
to inspect history. A recovered branch stays local; do not push it.

## Mac mini: remaining steps (not yet verified)

Everything above was verified on the MacBook only. The Mac mini clone has **not** been synced or
checked since the consolidation, so nothing here should be read as its current state. On the Mac
mini, follow [GIT_SYNC.md → Syncing an older clone](GIT_SYNC.md#syncing-an-older-clone-mac-mini):

1. `git status --short` is empty (commit or stash local work first).
2. `git fetch origin --prune`.
3. For each local branch other than `main`, `git cherry -v origin/main <branch>` shows only `-` lines
   or nothing. A `+` line is unique work: stop and review it before deleting anything.
4. `git switch main && git merge --ff-only origin/main`, then `git rev-parse main origin/main` match.
5. `git branch -d` the merged branches, `git worktree list`, `git worktree prune`.
6. Record the result (commit, branches, worktrees) in GIT_SYNC.md's verified-state section.
