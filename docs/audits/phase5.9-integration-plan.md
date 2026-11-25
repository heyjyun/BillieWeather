# Phase 5.9: plan for merging into `main`

Prepared 2026-11-25, rehearsed in a throwaway clone. Nothing was merged or pushed.

| Fact | Evidence |
| --- | --- |
| `main` = `origin/main` = `e4380af` as last fetched, an ancestor of `autonomous-development` | `merge-base`, 0 commits only on `main`. The remote was not contacted |
| Textual conflicts | none: fast-forward; the merged tree equals the branch tree |
| Uncommitted work in the `billieweather` checkout | 75 changed and 40 untracked files. **Every one is byte-identical to branch commit `d3061e4`**; committed in a clone, its tree equals that commit's tree |
| Migrations on the branch | `20261123000100`, `20261124000100`, `20261125000100`, all additive |
| Secrets | pattern scan of the added lines: none found. Not a full secret scanner |
| Tracked env files | `.env.example`, `services/identity-api/.env.example`, `billieforecast/.env.example`, `.overmind.env` |

Steps, after approval and only while nothing uses the `billieweather` checkout (its development servers on 3000, 8100 and 1420 are running):

1. `git fetch`. Stop if `origin/main` is no longer `e4380af`.
2. In `billieweather`: confirm `git status` still shows the same files, then keep them: `git switch -c backup/phase-1a-wip && git add -A && git commit -m "Keep Phase 1a working copy"`, and check `git diff backup/phase-1a-wip d3061e4` prints nothing. Stop if it prints anything: that is new work.
3. `git switch main && git merge --ff-only autonomous-development`.
4. Run the four suites. Leave `BILLIE_MODULE_SYNC` unset for Rails.
5. Local development databases need `db:migrate`; every local sign-in has to be repeated once.
6. Pushing needs its own approval. Merging `main` does not deploy: automatic deploys are to be verified off in Render first.

Undo before pushing: `git switch main && git reset --keep e4380af`; the branch and the backup stay.

## Rechecked 2026-11-25 (overnight)

All 115 dirty files in `billieweather` are still byte-identical to `d3061e4` (hash comparison, read-only). `main` = `e4380af`, 0 commits of its own. Fast-forward rehearsed in a clone: the merged tree equals the branch tree. `rollback/session-safe` is a new local branch on top of `e4380af`; it is not part of the merge.
