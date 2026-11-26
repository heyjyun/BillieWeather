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

The primary checkout `billieweather/` now has `main` checked out.

## Still open on 2026-11-26

1. **Render Auto-Deploy has not been switched Off yet.** This session had no access to the Render
   dashboard or API. Until the owner sets `web` → Settings → Build & Deploy → Auto-Deploy to **Off**
   and confirms it, `main` is not pushed (a push would start a production deploy).
2. After that: `ops/git-sync.sh push main`, check `git rev-parse main origin/main`, confirm
   `git merge-base --is-ancestor dbd85e7 origin/main`, then `git push origin --delete
   rollback/session-safe` so GitHub has only `main`.
3. `autonomous-development` and its worktree `billieweather-roadmap` are kept for now: a local Puma
   and identity-api QA server run from that worktree. It has no unique content. Once those servers are
   stopped: `git worktree remove ../billieweather-roadmap && git branch -D autonomous-development`
   (`-D` because its one commit is merged by content, not by ancestry).
4. Mac mini: see [GIT_SYNC.md → Syncing an older clone](GIT_SYNC.md#syncing-an-older-clone-mac-mini).
